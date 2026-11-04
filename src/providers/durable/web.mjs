// The `web_search` / `web_fetch` tools of durable conversations, backed by the
// private even-search service (SearXNG + trafilatura on the LAN), the same
// service the glasses' own web search uses (even-cloud-shim `_web_search`):
//   GET {base}/search?q=<query>&n=5 → {"results": [{"title","url","snippet"}, …]}
//   GET {base}/fetch?url=<url>      → {"text": "<extracted page text>"}
//
// Agents get the web as first-class tools instead of trying helper scripts from
// bash (which the guard blocks). The tools never touch the filesystem or a
// shell, so the guard does not vet them; every page is fetched by even-search,
// never by the bridge host itself. Neither tool throws into the model: a failure
// is a result with an `error` field.
//
// Off unless EVEN_BRIDGE_WEB_SEARCH_URL is set (read once at provider start).
// Logs the query / URL and counts only, never page text or snippets.

import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const WEB_EXTENSION = "even-web";
export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";
export const WEB_SEARCH_N = 5; // results asked from /search and kept
export const WEB_FETCH_TOP = 2; // results whose page text is fetched (in parallel)
export const WEB_SNIPPET_MAX = 300; // chars of snippet per result
export const WEB_TEXT_MAX = 1200; // chars of page text per search result
export const WEB_FETCH_MAX = 6000; // chars of page text from web_fetch
export const DEFAULT_TIMEOUTS = Object.freeze({ searchMs: 8000, fetchMs: 6000 });

/** The even-search base URL from `EVEN_BRIDGE_WEB_SEARCH_URL` (trailing slashes stripped), or "" when unset. */
export function webSearchUrlFrom(env = process.env) {
  return String(env.EVEN_BRIDGE_WEB_SEARCH_URL ?? "").trim().replace(/\/+$/, "");
}

const SEARCH_PARAMETERS = {
  type: "object",
  properties: { query: { type: "string", description: "What to search the web for" } },
  required: ["query"],
  additionalProperties: false,
};
const FETCH_PARAMETERS = {
  type: "object",
  properties: { url: { type: "string", description: "The http(s) URL of the page to read" } },
  required: ["url"],
  additionalProperties: false,
};

const SEARCH_DESCRIPTION =
  "Search the web for current information, facts you don't know, news, prices, places; returns titles, URLs and " +
  "snippets with extracted page text for the top results. Use it instead of any shell command or script for web " +
  "access, and name the source site(s) in your answer.";
const FETCH_DESCRIPTION =
  "Read the extracted text of one web page (http or https URL), e.g. a result of web_search that needs more detail. " +
  "Returns at most 6000 characters of text. Name the source site in your answer.";

const json = (value) => ({ output: [{ type: "text", text: JSON.stringify(value) }] });

/** GET `url` as JSON within `ms`, also aborted with the tool call. Throws on a timeout, a non-2xx or bad JSON. */
async function getJson(fetchImpl, url, ms, context) {
  const timer = AbortSignal.timeout(ms);
  const signal = context?.abortSignal ? AbortSignal.any([timer, context.abortSignal]) : timer;
  const res = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * The normalised http(s) URL of `s` (`href`) and its form for the log (`shown`, no userinfo), or null.
 * The URL parser drops tabs and newlines, so only `href` is ever requested, logged or returned
 * (a raw string could forge bridge log lines).
 */
export function httpUrl(s) {
  let u;
  try {
    u = new URL(String(s ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const href = u.href;
  u.username = "";
  u.password = "";
  return { href, shown: u.href };
}

/** A fixed reason for the log: never upstream content (a JSON parse error quotes the body). */
const reasonOf = (err) => {
  if (err?.name === "TimeoutError") return "timeout";
  if (err?.name === "AbortError") return "aborted";
  if (/^HTTP \d+$/.test(err?.message ?? "")) return err.message;
  if (err instanceof SyntaxError) return "bad JSON";
  return "unreachable";
};

/**
 * The `even-web` extension, or null when `baseUrl` is empty (the caller then installs nothing).
 * @param {object} o
 * @param {string} o.baseUrl even-search base URL (trailing slashes stripped)
 * @param {{ log?: Function, warn?: Function }} [o.log]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {{ searchMs?: number, fetchMs?: number }} [o.timeouts]
 */
export function createWebExtension({ baseUrl, log, fetchImpl = globalThis.fetch, timeouts = {} } = {}) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const { searchMs, fetchMs } = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const info = (line) => (log?.log ?? log?.info ?? console.log).call(log, line);
  const searchUrl = (q) => `${base}/search?${new URLSearchParams({ q, n: String(WEB_SEARCH_N) })}`;
  const fetchUrl = (u) => `${base}/fetch?${new URLSearchParams({ url: u })}`;

  /** Page text of `url` cut at `max`; throws on any failure. */
  const pageText = async (url, max, context) => {
    const data = await getJson(fetchImpl, fetchUrl(url), fetchMs, context);
    return String(data?.text ?? "").slice(0, max);
  };

  const webSearch = defineTool({
    name: WEB_SEARCH_TOOL,
    description: SEARCH_DESCRIPTION,
    parameters: SEARCH_PARAMETERS,
    replay: "safe", // read-only: a rerun after a crash just searches again
    async execute(args, _api, context) {
      const unavailable = { results: [], error: "search unavailable" };
      const query = String(args?.query ?? "").trim();
      if (!query) return json(unavailable);
      let results;
      try {
        const data = await getJson(fetchImpl, searchUrl(query), searchMs, context);
        const items = Array.isArray(data?.results) ? data.results : [];
        results = items
          .filter((it) => it && typeof it === "object")
          .map((it) => ({ it, u: httpUrl(it.url) }))
          .filter(({ u }) => u) // only http(s) results are kept (and fetched)
          .slice(0, WEB_SEARCH_N)
          .map(({ it, u }) => ({ title: String(it.title ?? ""), url: u.href, snippet: String(it.snippet ?? "").slice(0, WEB_SNIPPET_MAX), text: "" }));
      } catch (err) {
        info(`[durable:web] search ${JSON.stringify(query)} failed: ${reasonOf(err)}`);
        return json(unavailable);
      }
      await Promise.all(
        results.slice(0, WEB_FETCH_TOP).map(async (r) => {
          try {
            r.text = await pageText(r.url, WEB_TEXT_MAX, context);
          } catch {
            /* a page that fails or times out keeps text "" */
          }
        }),
      );
      info(`[durable:web] search ${JSON.stringify(query)} -> ${results.length} results`);
      return json({ results });
    },
  });

  const webFetch = defineTool({
    name: WEB_FETCH_TOOL,
    description: FETCH_DESCRIPTION,
    parameters: FETCH_PARAMETERS,
    replay: "safe",
    async execute(args, _api, context) {
      const u = httpUrl(args?.url);
      if (!u) return json({ error: "only http(s) URLs" });
      const url = u.href;
      try {
        const text = await pageText(url, WEB_FETCH_MAX, context);
        info(`[durable:web] fetch ${u.shown} -> ${text.length} chars`);
        return json({ url, text });
      } catch (err) {
        const why = err?.name === "TimeoutError" ? "timeout" : "fetch failed";
        info(`[durable:web] fetch ${u.shown} -> failed (${reasonOf(err)})`);
        return json({ url, text: "", error: why });
      }
    },
  });

  return defineExtension({ name: WEB_EXTENSION, tools: [webSearch, webFetch] });
}
