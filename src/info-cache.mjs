// Cached GET /api/info.
//
// The phone probes `GET /api/info` before it opens the Terminal glasses app and
// gives up after about 2 s (`terminal_host_unavailable`). The official route
// calls the Claude provider's getInfo() on every request, which lists recent
// Claude sessions, reads their message files for the model and runs
// `claude --version` and `claude auth status` (up to 8 s; 0.5-2 s in practice).
// The answer is static for minutes, so the extension router serves it from
// this stale-while-revalidate cache instead.

export const INFO_CACHE_DEFAULT_MS = 300_000;

/** What the phone gets while the first getInfo() has not finished yet. */
export const INFO_FALLBACK = Object.freeze({
  account: Object.freeze({ email: "", organization: "", subscriptionType: "" }),
  model: "Unknown",
  version: "Unknown",
  provider: "claude",
});

/**
 * EVEN_BRIDGE_INFO_CACHE_MS: the cache TTL in ms (default 300000). `0` turns the
 * cache off (the request goes to the official route); an invalid value keeps
 * the default.
 */
export function infoCacheMs(env = process.env) {
  const raw = String(env.EVEN_BRIDGE_INFO_CACHE_MS ?? "").trim();
  if (raw === "") return INFO_CACHE_DEFAULT_MS;
  if (!/^\d+$/.test(raw)) return INFO_CACHE_DEFAULT_MS;
  return Number(raw);
}

/**
 * The `extra.expose` value of the official /api/info route. A copy of the
 * unexported getExposeType() in @evenrealities/even-terminal dist/routes/core.js.
 */
export function exposeType(env = process.env) {
  const expose = env.EVEN_TERMINAL_EXPOSE_PROVIDER;
  if (expose === "pinggy" || expose === "bore" || expose === "ngrok") return expose;
  if (expose) return "other";
  if (env.EVEN_HOST_MODE === "tailscale") return "tailscale";
  return env.EVEN_HOST_MODE ? "other" : "off";
}

/**
 * @param {object} o
 * @param {() => Promise<object>} o.getInfo   the provider's getInfo()
 * @param {number} [o.ttlMs]                  age after which get() refreshes in the background
 * @param {number} [o.primeTimeoutMs]         how long an unprimed get() waits for the first value
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createInfoCache({
  getInfo,
  ttlMs = INFO_CACHE_DEFAULT_MS,
  primeTimeoutMs = 500,
  log = (line) => console.log(line),
  now = Date.now,
} = {}) {
  let value = null; // last good getInfo() result
  let checkedAt = 0; // time of the last finished refresh (success or failure)
  let inflight = null; // the one running refresh

  function refresh() {
    if (inflight) return inflight;
    const started = now();
    inflight = (async () => {
      try {
        const info = await getInfo();
        value = info;
        log(`[bridge] info cache refreshed in ${now() - started} ms`);
      } catch (err) {
        log(`[bridge] info cache refresh failed: ${err?.message ?? String(err)}`);
      } finally {
        checkedAt = now();
        inflight = null;
      }
    })();
    return inflight;
  }

  async function get() {
    if (value) {
      if (now() - checkedAt >= ttlMs) refresh();
      return value;
    }
    const pending = refresh();
    let timer;
    await Promise.race([pending, new Promise((r) => { timer = setTimeout(r, primeTimeoutMs); })]);
    clearTimeout(timer);
    return value ?? INFO_FALLBACK;
  }

  /** Start the first refresh (once, at server start). */
  function prime() {
    return refresh();
  }

  return { get, prime };
}
