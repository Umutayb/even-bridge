// Bridge-side index of Durable conversations: maps the bridge's session ids
// ("dur-<uuid>") to Durable conversation ids plus the metadata the phone and
// the shim list. It lives in its OWN SQLite file next to Durable's store
// (`<storePath>.sessions.sqlite`) — Durable's store is never written by us.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { expandHome } from "./models.mjs";

const ORIGINS = new Set(["evenai", "phone", "overseer"]);
const ENGINES = new Set(["native", "lets-code"]);
const COLUMNS = "sid, conversation_id, name, cwd, model_provider, model_id, created_at, last_seen, origin, archived, max_turns, engine, ttl_s";
// Schema v2: origin 'overseer', the session's engine and an optional TTL.
const SESSIONS_DDL = (table) => `CREATE TABLE ${table} (
      sid TEXT PRIMARY KEY,
      conversation_id INTEGER,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('evenai', 'phone', 'overseer')),
      archived INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER,
      engine TEXT NOT NULL DEFAULT 'native',
      ttl_s INTEGER
    )`;
export const REQUEST_TTL_S = 7 * 86400;
const PAGE = 200;

export const sessionMapPath = (storePath) => expandHome(storePath) + ".sessions.sqlite";

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class SessionMap {
  /**
   * @param {string} storePath Durable's store path; the map opens `storePath + ".sessions.sqlite"`.
   * @param {{ now?: () => number, requestTtlS?: number }} [opts] clock in epoch seconds (tests);
   *   request rows older than `requestTtlS` are pruned on open.
   */
  constructor(storePath, { now = nowSeconds, requestTtlS = REQUEST_TTL_S } = {}) {
    this.now = now;
    this.path = sessionMapPath(storePath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
    if (!existing) this.db.exec(SESSIONS_DDL("sessions"));
    else this.migrate(existing.sql);
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_conversation ON sessions (conversation_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_created ON sessions (archived, created_at)");
    // Which session a new-session request created, so a retried prompt with the
    // same requestId (HTTP retry, bridge restart) finds it instead of starting a second agent.
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY,
      sid TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Subagent children (owned conversations the sessions table does not know): which
    // session's conversation owns them and the agent file's role, so the guard can
    // resolve a child's cwd and read-only role again after a restart, before resume.
    this.db.exec(`CREATE TABLE IF NOT EXISTS children (
      child_id INTEGER PRIMARY KEY,
      parent_sid TEXT NOT NULL,
      role TEXT
    )`);
    this.requestTtlS = requestTtlS;
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`),
      page: this.db.prepare(`SELECT rowid AS _rowid, ${COLUMNS} FROM sessions WHERE archived = 0 AND last_seen >= ? AND rowid > ? ORDER BY rowid LIMIT ?`),
      get: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE sid = ?`),
      byConversation: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`),
      list: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE archived = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?`),
      listCwd: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE archived = 0 AND cwd = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
      touch: this.db.prepare("UPDATE sessions SET last_seen = ? WHERE sid = ?"),
      archive: this.db.prepare("UPDATE sessions SET archived = 1 WHERE sid = ?"),
      setConversation: this.db.prepare("UPDATE sessions SET conversation_id = ? WHERE sid = ?"),
      noteRequest: this.db.prepare("INSERT OR IGNORE INTO requests (request_id, sid, created_at) VALUES (?, ?, ?)"),
      sidForRequest: this.db.prepare("SELECT sid FROM requests WHERE request_id = ?"),
      pruneRequests: this.db.prepare("DELETE FROM requests WHERE created_at < ?"),
      noteChild: this.db.prepare("INSERT INTO children (child_id, parent_sid, role) VALUES (?, ?, ?) ON CONFLICT(child_id) DO UPDATE SET parent_sid = excluded.parent_sid, role = excluded.role"),
      children: this.db.prepare("SELECT child_id, parent_sid, role FROM children"),
      pruneChildren: this.db.prepare(
        "DELETE FROM children WHERE parent_sid NOT IN (SELECT sid FROM sessions WHERE archived = 0 AND last_seen >= ?)",
      ),
    };
    this.pruneRequests();
  }

  /**
   * v1 → v2 in place. A v1 table's CHECK lacks 'overseer', which SQLite cannot ALTER: the table is
   * rebuilt in one transaction (rows kept, both indexes recreated by the caller). Maps that predate a
   * column get it by ALTER TABLE.
   */
  migrate(sql) {
    const cols = () => this.db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
    if (!cols().includes("max_turns")) this.db.exec("ALTER TABLE sessions ADD COLUMN max_turns INTEGER");
    if (!cols().includes("engine")) this.db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'native'");
    if (!cols().includes("ttl_s")) this.db.exec("ALTER TABLE sessions ADD COLUMN ttl_s INTEGER");
    if (String(sql).includes("'overseer'")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP TABLE IF EXISTS sessions_v2");
      this.db.exec(SESSIONS_DDL("sessions_v2"));
      this.db.exec(`INSERT INTO sessions_v2 (${COLUMNS}) SELECT ${COLUMNS} FROM sessions`);
      this.db.exec("DROP TABLE sessions");
      this.db.exec("ALTER TABLE sessions_v2 RENAME TO sessions");
      this.db.exec("CREATE INDEX IF NOT EXISTS sessions_conversation ON sessions (conversation_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS sessions_created ON sessions (archived, created_at)");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** @returns {string} the new sid ("dur-" + uuid). */
  create({ name, cwd, modelRef, origin, conversationId = null, maxTurns = null, engine = "native", ttlS = null }) {
    if (!ORIGINS.has(origin)) throw new Error(`invalid origin ${JSON.stringify(origin)}: expected evenai|phone|overseer`);
    if (!ENGINES.has(engine)) throw new Error(`invalid engine ${JSON.stringify(engine)}: expected native|lets-code`);
    const sid = "dur-" + randomUUID();
    if (!name) name = (cwd && basename(cwd)) || "agent";
    const t = this.now();
    this.stmt.insert.run(sid, conversationId, name, cwd, modelRef?.provider ?? null, modelRef?.modelId ?? null, t, t, origin, maxTurns, engine, ttlS);
    return sid;
  }

  get(sid) {
    return plain(this.stmt.get.get(sid));
  }

  byConversation(id) {
    return plain(this.stmt.byConversation.get(id));
  }

  /** Non-archived rows, newest first, optionally only those in `cwd`. */
  list({ limit = 100, cwd } = {}) {
    const rows = cwd ? this.stmt.listCwd.all(cwd, limit) : this.stmt.list.all(limit);
    return rows.map(plain);
  }

  /**
   * Every non-archived row seen at or after `seenSince` (epoch s), oldest first,
   * read in pages so a large map is never loaded at once.
   */
  *rows({ seenSince = 0, pageSize = PAGE } = {}) {
    let after = 0;
    for (;;) {
      const page = this.stmt.page.all(seenSince, after, pageSize);
      for (const r of page) {
        after = r._rowid;
        const { _rowid, ...row } = r;
        yield row;
      }
      if (page.length < pageSize) return;
    }
  }

  /** Record the Durable conversation once it has been created. */
  setConversation(sid, conversationId) {
    this.stmt.setConversation.run(conversationId, sid);
  }

  /** Remember that `requestId` created `sid` (first writer wins). */
  noteRequest(requestId, sid) {
    this.stmt.noteRequest.run(String(requestId), sid, this.now());
  }

  /** The sid a new-session `requestId` created, if any. */
  sidForRequest(requestId) {
    return this.stmt.sidForRequest.get(String(requestId))?.sid;
  }

  /** Drop request rows older than the TTL (on open, and periodically by the provider). @returns {number} rows removed */
  pruneRequests() {
    return Number(this.stmt.pruneRequests.run(this.now() - this.requestTtlS).changes);
  }

  /** Remember a subagent child conversation of `parentSid`, with its agent file's role. */
  noteChild(childId, parentSid, role = null) {
    this.stmt.noteChild.run(childId, parentSid, role ?? null);
  }

  /** Drop child rows whose parent is archived, gone, or not seen since `seenSince` (epoch s). @returns {number} */
  pruneChildren(seenSince) {
    return Number(this.stmt.pruneChildren.run(seenSince).changes);
  }

  /** Every recorded child: `{ child_id, parent_sid, role }`. */
  children() {
    return this.stmt.children.all().map(plain);
  }

  touch(sid) {
    this.stmt.touch.run(this.now(), sid);
  }

  archive(sid) {
    this.stmt.archive.run(sid);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

// node:sqlite rows have a null prototype; hand out ordinary objects.
const plain = (row) => (row ? { ...row } : undefined);
