import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createDurableProvider } from "../src/providers/durable/provider.mjs";
import {
  createWebExtension,
  webSearchUrlFrom,
  WEB_EXTENSION,
  WEB_SNIPPET_MAX,
  WEB_TEXT_MAX,
  WEB_FETCH_MAX,
} from "../src/providers/durable/web.mjs";
import { startFakeOpenAI, fakeModelsJson } from "./helpers/fake-openai.mjs";

// A local fake even-search: `/search` answers `searchReply(q)` (7 results by default),
// `/fetch` answers `{text}` from `pages` keyed by URL. A URL containing "hang" never
// answers; `searchMode` "500" / "hang" breaks /search. Every request URL is kept.
let es;
let fake;
let root;
const seen = [];
let searchMode = "ok";
const LONG = "x".repeat(5000);
const HUGE = "y".repeat(9000);
const RESULTS = Array.from({ length: 7 }, (_, i) => ({
  title: `Result ${i}`,
  url: i === 1 ? "https://site1.example/hang" : `https://site${i}.example/page`,
  snippet: `s${i}`.padEnd(400, "-"),
}));
const pages = new Map([
  ["https://site0.example/page", LONG],
  ["https://site2.example/page", "two"],
  ["https://read.example/a", HUGE],
]);
const hung = new Set();

before(async () => {
  es = createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/search") {
      if (searchMode === "hang") return void hung.add(res);
      if (searchMode === "500") return void res.writeHead(500).end("boom");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: RESULTS }));
      return;
    }
    if (u.pathname === "/fetch") {
      const target = u.searchParams.get("url");
      if (target.includes("hang")) return void hung.add(res);
      if (!pages.has(target)) return void res.writeHead(502).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: pages.get(target) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => es.listen(0, "127.0.0.1", r));
  fake = await startFakeOpenAI();
  root = realpathSync(mkdtempSync(join(tmpdir(), "dur-web-")));
  writeFileSync(join(root, "models.json"), JSON.stringify(fakeModelsJson(fake.baseUrl)));
});
after(async () => {
  for (const res of hung) res.destroy();
  es.closeAllConnections?.();
  await new Promise((r) => es.close(r));
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${es.address().port}`;
const lines = [];
const log = { log: (l) => lines.push(l), warn() {}, error() {} };
const ext = (o = {}) => createWebExtension({ baseUrl: `${base()}/`, log, timeouts: { searchMs: 800, fetchMs: 300 }, ...o });
const tool = (e, name) => e.tools.find((t) => t.name === name);
const run = async (e, name, args) => JSON.parse((await tool(e, name).execute(args, {}, {})).output[0].text);

test("unset base URL: no extension, no tools", () => {
  assert.equal(createWebExtension({ baseUrl: "" }), null);
  assert.equal(createWebExtension({ baseUrl: "  " }), null);
  assert.equal(createWebExtension({}), null);
  assert.equal(webSearchUrlFrom({}), "");
  assert.equal(webSearchUrlFrom({ EVEN_BRIDGE_WEB_SEARCH_URL: " https://evsearch.example// " }), "https://evsearch.example");
});

test("the extension offers web_search and web_fetch", () => {
  const e = ext();
  assert.equal(e.name, WEB_EXTENSION);
  assert.deepEqual(e.tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
  assert.match(tool(e, "web_search").description, /current information/);
});

test("web_search keeps 5 results, cuts snippets, fetches the top 2 (a hanging fetch keeps text empty)", async () => {
  searchMode = "ok";
  seen.length = 0;
  lines.length = 0;
  const t0 = Date.now();
  const out = await run(ext(), "web_search", { query: "news & weather/today?" });
  assert.ok(Date.now() - t0 < 2000, "the hanging fetch is bounded by the fetch timeout");
  assert.equal(out.error, undefined);
  assert.equal(out.results.length, 5);
  for (const r of out.results) assert.ok(r.snippet.length <= WEB_SNIPPET_MAX);
  assert.equal(out.results[0].snippet.length, WEB_SNIPPET_MAX);
  assert.equal(out.results[0].text, LONG.slice(0, WEB_TEXT_MAX));
  assert.equal(out.results[1].text, ""); // its /fetch hangs
  assert.equal(out.results[2].text, ""); // not fetched: only the top 2
  assert.deepEqual(out.results[0].title, "Result 0");
  // the query reaches even-search URL-encoded, n=5; only the top 2 are fetched
  const search = seen.find((u) => u.startsWith("/search"));
  assert.equal(search, `/search?q=news+%26+weather%2Ftoday%3F&n=5`);
  assert.equal(new URL(search, "http://x").searchParams.get("q"), "news & weather/today?");
  assert.equal(seen.filter((u) => u.startsWith("/fetch")).length, 2);
  assert.ok(seen.includes(`/fetch?url=${encodeURIComponent("https://site0.example/page")}`));
  assert.deepEqual(lines, ['[durable:web] search "news & weather/today?" -> 5 results']);
  assert.ok(!lines.join("\n").includes("xxx"), "page text is never logged");
});

test("web_search: /search 500 or hang → empty results with an error, never a throw", async () => {
  for (const mode of ["500", "hang"]) {
    searchMode = mode;
    const t0 = Date.now();
    const out = await run(ext(), "web_search", { query: "q" });
    assert.deepEqual(out, { results: [], error: "search unavailable" }, mode);
    assert.ok(Date.now() - t0 < 2000, `${mode} is bounded by the search timeout`);
  }
  searchMode = "ok";
  assert.deepEqual(await run(ext(), "web_search", { query: "  " }), { results: [], error: "search unavailable" });
});

test("web_search: an unreachable even-search → error result", async () => {
  const out = await run(ext({ baseUrl: "http://127.0.0.1:1" }), "web_search", { query: "q" });
  assert.deepEqual(out, { results: [], error: "search unavailable" });
});

test("web_fetch: cuts text, refuses non-http(s) without a request, reports failures", async () => {
  lines.length = 0;
  const ok = await run(ext(), "web_fetch", { url: "https://read.example/a" });
  assert.equal(ok.url, "https://read.example/a");
  assert.equal(ok.text, HUGE.slice(0, WEB_FETCH_MAX));
  assert.deepEqual(lines, [`[durable:web] fetch https://read.example/a -> ${WEB_FETCH_MAX} chars`]);

  seen.length = 0;
  for (const url of ["ftp://files.example/x", "file:///etc/passwd", "not a url", ""]) {
    assert.deepEqual(await run(ext(), "web_fetch", { url }), { error: "only http(s) URLs" }, url);
  }
  assert.deepEqual(seen, [], "no request for a refused URL");

  const hang = await run(ext(), "web_fetch", { url: "https://slow.example/hang" });
  assert.deepEqual(hang, { url: "https://slow.example/hang", text: "", error: "timeout" });
  const bad = await run(ext(), "web_fetch", { url: "https://missing.example/" });
  assert.deepEqual(bad, { url: "https://missing.example/", text: "", error: "fetch failed" });
});

// The provider installs the extension only with a base URL, and conversations are offered its tools.
let n = 0;
function setup(extra = {}) {
  const dir = join(root, `case-${++n}`);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const frames = [];
  const plog = [];
  const provider = createDurableProvider((sid, frame) => frames.push({ sid, ...frame }), {
    hub: { clientCount: () => 0 },
    storePath: join(dir, "durable.sqlite"),
    storage: new MemoryStorage(),
    modelsPath: join(root, "models.json"),
    settingsPath: join(dir, "no-settings.json"),
    defaultCwd: work,
    allowedCwds: [dir],
    guard: { wrapper: "none", log: () => {} },
    log: { warn() {}, error() {}, log: (l) => plog.push(l) },
    agents: new Map(),
    allowedAgents: [],
    env: {},
    ...extra,
  });
  return { provider, frames, plog };
}
const until = async (cond, ms = 8000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const idle = (frames, sid) => frames.some((f) => f.sid === sid && f.type === "status" && f.state === "idle");
const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);
const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("\n") : "");

test("provider without EVEN_BRIDGE_WEB_SEARCH_URL: one log line, no web tools offered", async () => {
  const { provider, frames, plog } = setup();
  assert.ok(plog.includes("[durable] web tools off (EVEN_BRIDGE_WEB_SEARCH_URL unset)"));
  const from = fake.requests.length;
  const { sessionId } = await provider.prompt(undefined, "hello", undefined, {});
  await until(() => idle(frames, sessionId));
  const names = toolNames(fake.requests[from]);
  assert.ok(names.includes("bash"), `tools offered: ${names}`);
  assert.ok(!names.includes("web_search") && !names.includes("web_fetch"), `tools offered: ${names}`);
  await provider.stopAll();
});

test("provider with EVEN_BRIDGE_WEB_SEARCH_URL: web_search is offered and runs through even-search", async () => {
  searchMode = "ok";
  const { provider, frames, plog } = setup({ env: { EVEN_BRIDGE_WEB_SEARCH_URL: `${base()}/` }, web: { timeouts: { fetchMs: 300 } } });
  assert.ok(!plog.some((l) => l.includes("web tools off")));
  const from = fake.requests.length;
  const { sessionId } = await provider.prompt(undefined, `TOOL web_search ${JSON.stringify({ query: "top stories" })}`, undefined, {});
  await until(() => idle(frames, sessionId));
  const names = toolNames(fake.requests[from]);
  assert.ok(names.includes("web_search") && names.includes("web_fetch"), `tools offered: ${names}`);
  const results = fake.requests
    .slice(from)
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === "tool").map((m) => contentText(m.content)));
  const payload = JSON.parse(results.find((t) => t.includes("results")));
  assert.equal(payload.results.length, 5);
  assert.ok(plog.includes('[durable:web] search "top stories" -> 5 results'));
  await provider.stopAll();
});
