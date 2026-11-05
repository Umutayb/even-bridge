// A fake of the shim's assistant tool server (plan Task A3's shape) for test/assistant-ext.test.mjs and
// scripts/assistant-smoke.mjs:
//   GET  /tools/schema      → { tools: [{ name, description, parameters, untrusted, phoneData, stubLabel? }], rememberPattern }
//   POST /tools/<name>      {args, toolCallId} → { content, isError }   (Bearer token checked on both: 401)
// The calendar answers from dated fixtures (Lasagna Fri 13 Nov 18:00, Team lunch Fri 6 Nov 12:30, nothing
// Thu 5 Nov) with the window echoed in words, like the shim's `_localize_fetch`. Every request is kept in
// `calls` (tool, args, toolCallId, the Authorization header's token *matched or not*, never the token).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

export const REMEMBER_PATTERN = "\\b(remember|note|save|memori[sz]e|don't forget|do not forget|dont forget)\\b";

const obj = (properties = {}, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const str = (description) => ({ type: "string", description });

/** The 16 shim tools of ASSISTANT_TOOLS (memory is lets-code's). */
export const SCHEMA_TOOLS = [
  { name: "fetch_calendar", description: "Fetch the user's calendar events between two dates, both included. Always pass explicit dates (YYYY-MM-DD).", parameters: obj({ from: str("first day, YYYY-MM-DD"), to: str("last day, YYYY-MM-DD"), keywords: str("optional words to match") }, ["from", "to"]), untrusted: false, phoneData: true, stubLabel: "calendar" },
  { name: "fetch_notes", description: "Fetch the user's notes from the phone.", parameters: obj({ query: str("optional words to match") }), untrusted: false, phoneData: true, stubLabel: "notes" },
  { name: "fetch_quicklist", description: "Fetch the user's quick list from the phone.", parameters: obj(), untrusted: false, phoneData: true, stubLabel: "quick list" },
  { name: "control_app", description: "Launch or control a glasses app (teleprompter, conversate, navigate, translate …).", parameters: obj({ app: str("the app"), action: str("launch | stop | …") }, ["app", "action"]), untrusted: false, phoneData: true, stubLabel: "app reply" },
  { name: "kb_search", description: "Search the user's knowledge base (documents, transcripts).", parameters: obj({ query: str("what to look for") }, ["query"]), untrusted: true, phoneData: false },
  { name: "web_search", description: "Search the web.", parameters: obj({ query: str("what to look for") }, ["query"]), untrusted: true, phoneData: false },
  { name: "get_preferences", description: "Read the user's Even AI preferences.", parameters: obj(), untrusted: false, phoneData: false },
  { name: "set_preference", description: "Change one Even AI preference.", parameters: obj({ key: str("preference"), value: str("new value") }, ["key", "value"]), untrusted: false, phoneData: false },
  { name: "agent_start", description: "Propose starting a coding agent; nothing starts until the user confirms.", parameters: obj({ task: str("what the agent should do") }, ["task"]), untrusted: false, phoneData: false },
  { name: "agent_list", description: "List the coding agents.", parameters: obj(), untrusted: false, phoneData: false },
  { name: "agent_status", description: "Show one coding agent's status.", parameters: obj({ label: str("the agent") }, ["label"]), untrusted: true, phoneData: false },
  { name: "agent_message", description: "Propose a message to a coding agent; nothing is sent until the user confirms.", parameters: obj({ label: str("the agent"), text: str("the message") }, ["label", "text"]), untrusted: false, phoneData: false },
  { name: "agent_stop", description: "Propose stopping a coding agent; nothing stops until the user confirms.", parameters: obj({ label: str("the agent") }, ["label"]), untrusted: false, phoneData: false },
  { name: "sessions_list", description: "List the bridge sessions (read-only).", parameters: obj(), untrusted: true, phoneData: false },
  { name: "session_read", description: "Read the end of one bridge session (read-only).", parameters: obj({ id: str("session id") }, ["id"]), untrusted: true, phoneData: false },
  { name: "overseer_outbox", description: "Read the overseer's outbox (read-only).", parameters: obj(), untrusted: true, phoneData: false },
];

export const CALENDAR = {
  "2026-11-05": [],
  "2026-11-06": ["12:30 Team lunch"],
  "2026-11-13": ["18:00 Lasagna"],
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (iso) => new Date(`${iso}T12:00:00Z`);
const words = (iso) => {
  const d = day(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export function calendarAnswer({ from, to } = {}, calendar = CALENDAR) {
  if (!ISO.test(String(from ?? "")) || !ISO.test(String(to ?? ""))) return { content: "from and to must be dates (YYYY-MM-DD)", isError: true };
  if (to < from) return { content: "to is before from", isError: true };
  const head = from === to ? `window: ${words(from)} 00:00–24:00 (local)` : `window: ${words(from)} 00:00 to ${words(to)} 24:00 (local)`;
  const lines = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    for (const e of calendar[iso] ?? []) lines.push(from === to ? e : `${words(iso)} ${e}`);
    if (lines.length > 50) break;
  }
  return { content: `${head}\n${lines.length ? lines.join("\n") : "no events"}`, isError: false };
}

const ANSWERS = {
  fetch_calendar: (a) => calendarAnswer(a),
  fetch_notes: () => ({ content: "notes (2): Buy oat milk · Call Anna about Saturday", isError: false }),
  fetch_quicklist: () => ({ content: "quick list (2): batteries · stamps", isError: false }),
  control_app: () => ({ content: "sent, unconfirmed", isError: false }),
  kb_search: (a) => ({ content: `1 passage for "${a.query ?? ""}": The borealis lab notes say the aurora was visible on 2 Nov.`, isError: false }),
  web_search: (a) => ({ content: `1 result for "${a.query ?? ""}": example.org: Aurora forecast, Kp 3 tonight.`, isError: false }),
  get_preferences: () => ({ content: JSON.stringify({ answer_style: "brief", web_search_enabled: true }), isError: false }),
  set_preference: (a) => ({ content: `ok: ${a.key} = ${a.value}`, isError: false }),
  agent_start: (a) => ({ content: `proposed: start an agent for "${a.task ?? ""}" (say yes to confirm)`, isError: false }),
  agent_list: () => ({ content: "no agents", isError: false }),
  agent_status: (a) => ({ content: `no agent ${a.label ?? ""}`, isError: true }),
  agent_message: (a) => ({ content: `proposed: message ${a.label ?? ""}`, isError: false }),
  agent_stop: (a) => ({ content: `proposed: stop ${a.label ?? ""}`, isError: false }),
  sessions_list: () => ({ content: "no sessions", isError: false }),
  session_read: (a) => ({ content: `no session ${a.id ?? ""}`, isError: true }),
  overseer_outbox: () => ({ content: "outbox empty", isError: false }),
};

/**
 * @param {object} [o]
 * @param {number} [o.port] 0 = ephemeral
 * @param {string} [o.tokenFile] the expected token, read per request (rotations are seen at once)
 * @param {string} [o.token] or a fixed token
 * @param {object[]} [o.tools] schema tools (default SCHEMA_TOOLS)
 * @param {string|null} [o.rememberPattern]
 * @param {Record<string, number>} [o.delays] per-tool delay in ms
 * @param {Record<string, (args) => {content, isError}>} [o.answers] per-tool overrides
 */
export async function startFakeToolServer({ port = 0, host = "127.0.0.1", tokenFile, token, tools = SCHEMA_TOOLS, rememberPattern = REMEMBER_PATTERN, delays = {}, answers = {} } = {}) {
  const calls = [];
  const expected = () => (tokenFile ? readFileSync(tokenFile, "utf8").trim() : String(token ?? ""));
  const server = createServer((req, res) => {
    const send = (code, o) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const authOk = req.headers.authorization === `Bearer ${expected()}`;
    if (req.method === "GET" && req.url === "/tools/schema") {
      calls.push({ t: Date.now(), tool: "<schema>", authOk });
      if (!authOk) return send(401, { error: "bad token" });
      return send(200, { tools, ...(rememberPattern != null ? { rememberPattern } : {}) });
    }
    const m = /^\/tools\/([a-z_]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) return send(404, { error: "not found" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        /* bad body */
      }
      const args = parsed.args ?? {};
      calls.push({ t: Date.now(), tool: m[1], args, toolCallId: parsed.toolCallId ?? null, authOk, body: parsed });
      if (!authOk) return send(401, { error: "bad token" });
      const fn = answers[m[1]] ?? ANSWERS[m[1]];
      if (!fn) return send(404, { error: `unknown tool ${m[1]}` });
      const answer = fn(args);
      const wait = delays[m[1]] ?? 0;
      if (wait > 0) setTimeout(() => send(200, answer), wait);
      else send(200, answer);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    calls,
    delays,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
