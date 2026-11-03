// Bridge-side index of Durable conversations: maps the bridge's session ids
// ("dur-<uuid>") to Durable conversation ids plus the metadata the phone and
// the shim list. It lives in its OWN SQLite file next to Durable's store
// (`<storePath>.sessions.sqlite`) — Durable's store is never written by us.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const ORIGINS = new Set(["evenai", "phone"]);
const COLUMNS = "sid, conversation_id, name, cwd, model_provider, model_id, created_at, last_seen, origin, archived";

export const sessionMapPath = (storePath) => storePath + ".sessions.sqlite";

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class SessionMap {
  /**
   * @param {string} storePath Durable's store path; the map opens `storePath + ".sessions.sqlite"`.
   * @param {{ now?: () => number }} [opts] clock in epoch seconds (tests).
   */
  constructor(storePath, { now = nowSeconds } = {}) {
    this.now = now;
    this.path = sessionMapPath(storePath);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      conversation_id INTEGER,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('evenai', 'phone')),
      archived INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_conversation ON sessions (conversation_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_created ON sessions (archived, created_at)");
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
      get: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE sid = ?`),
      byConversation: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`),
      list: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE archived = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?`),
      listCwd: this.db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE archived = 0 AND cwd = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
      touch: this.db.prepare("UPDATE sessions SET last_seen = ? WHERE sid = ?"),
      archive: this.db.prepare("UPDATE sessions SET archived = 1 WHERE sid = ?"),
      setConversation: this.db.prepare("UPDATE sessions SET conversation_id = ? WHERE sid = ?"),
    };
  }

  /** @returns {string} the new sid ("dur-" + uuid). */
  create({ name, cwd, modelRef, origin, conversationId = null }) {
    if (!ORIGINS.has(origin)) throw new Error(`invalid origin ${JSON.stringify(origin)}: expected evenai|phone`);
    const sid = "dur-" + randomUUID();
    const t = this.now();
    this.stmt.insert.run(sid, conversationId, name, cwd, modelRef?.provider ?? null, modelRef?.modelId ?? null, t, t, origin);
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

  /** Record the Durable conversation once it has been created. */
  setConversation(sid, conversationId) {
    this.stmt.setConversation.run(conversationId, sid);
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
