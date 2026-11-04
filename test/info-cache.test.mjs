import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Hub } from "../src/hub.mjs";
import { createExtRouter } from "../src/ext-router.mjs";
import { createInfoCache, infoCacheMs, exposeType, INFO_FALLBACK } from "../src/info-cache.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INFO = { account: { email: "a@b.c", organization: "Org", subscriptionType: "max" }, model: "Opus 5.5", version: "3.0.0", provider: "claude" };

/** A getInfo() whose delay/failure the test controls; counts calls and tracks concurrency. */
function fakeInfo({ delayMs = 0, value = INFO } = {}) {
  const f = {
    calls: 0,
    live: 0,
    maxLive: 0,
    delayMs,
    value,
    fail: null,
    async getInfo() {
      f.calls++;
      f.live++;
      f.maxLive = Math.max(f.maxLive, f.live);
      try {
        await sleep(f.delayMs);
        if (f.fail) throw new Error(f.fail);
        return { ...f.value, n: f.calls };
      } finally {
        f.live--;
      }
    },
  };
  return f;
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("infoCacheMs: default 300000, 0 disables, invalid keeps the default", () => {
  assert.equal(infoCacheMs({}), 300_000);
  assert.equal(infoCacheMs({ EVEN_BRIDGE_INFO_CACHE_MS: "0" }), 0);
  assert.equal(infoCacheMs({ EVEN_BRIDGE_INFO_CACHE_MS: " 60000 " }), 60_000);
  assert.equal(infoCacheMs({ EVEN_BRIDGE_INFO_CACHE_MS: "-5" }), 300_000);
  assert.equal(infoCacheMs({ EVEN_BRIDGE_INFO_CACHE_MS: "soon" }), 300_000);
});

test("exposeType mirrors the official route's getExposeType()", () => {
  assert.equal(exposeType({}), "off");
  assert.equal(exposeType({ EVEN_TERMINAL_EXPOSE_PROVIDER: "ngrok" }), "ngrok");
  assert.equal(exposeType({ EVEN_TERMINAL_EXPOSE_PROVIDER: "x" }), "other");
  assert.equal(exposeType({ EVEN_HOST_MODE: "tailscale" }), "tailscale");
  assert.equal(exposeType({ EVEN_HOST_MODE: "lan" }), "other");
});

test("a primed value is served instantly without calling getInfo again", async () => {
  const f = fakeInfo();
  const logs = [];
  const cache = createInfoCache({ getInfo: f.getInfo, log: (l) => logs.push(l) });
  await cache.prime();
  f.delayMs = 1000; // a call now would be slow
  const t0 = performance.now();
  const v = await cache.get();
  assert.ok(performance.now() - t0 < 20, "served from the cache");
  assert.equal(v.model, "Opus 5.5");
  assert.equal(f.calls, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[bridge\] info cache refreshed in \d+ ms$/);
  assert.ok(!logs[0].includes("a@b.c"), "no account details in the log");
});

test("after the TTL the old value is served while a background refresh runs", async () => {
  const f = fakeInfo();
  const c = clock();
  const cache = createInfoCache({ getInfo: f.getInfo, ttlMs: 1000, now: c.now, log: () => {} });
  await cache.prime();
  assert.equal((await cache.get()).n, 1);

  c.t += 999;
  assert.equal((await cache.get()).n, 1);
  assert.equal(f.calls, 1, "not stale yet");

  c.t += 1;
  f.delayMs = 50;
  const t0 = performance.now();
  assert.equal((await cache.get()).n, 1, "the old value meanwhile");
  assert.ok(performance.now() - t0 < 20);
  assert.equal(f.calls, 2, "refresh started");
  assert.equal((await cache.get()).n, 1, "still the old value while the refresh runs");
  assert.equal(f.calls, 2, "one refresh in flight");
  await sleep(80);
  assert.equal((await cache.get()).n, 2, "the refreshed value");
});

test("a failing refresh keeps the old value and logs once", async () => {
  const f = fakeInfo();
  const c = clock();
  const logs = [];
  const cache = createInfoCache({ getInfo: f.getInfo, ttlMs: 1000, now: c.now, log: (l) => logs.push(l) });
  await cache.prime();
  c.t += 1000;
  f.fail = "claude auth status timed out";
  assert.equal((await cache.get()).n, 1);
  await sleep(10);
  assert.equal((await cache.get()).n, 1, "old value kept");
  assert.equal((await cache.get()).n, 1);
  assert.equal(f.calls, 2, "no retry before the next TTL");
  assert.deepEqual(logs.slice(1), ["[bridge] info cache refresh failed: claude auth status timed out"]);

  c.t += 1000;
  f.fail = null;
  await cache.get();
  await sleep(10);
  assert.equal((await cache.get()).n, 3, "retried after the TTL");
});

test("unprimed: a slow getInfo gives the fallback within primeTimeoutMs, the prime continues", async () => {
  const f = fakeInfo({ delayMs: 300 });
  const cache = createInfoCache({ getInfo: f.getInfo, primeTimeoutMs: 50, log: () => {} });
  cache.prime();
  const t0 = performance.now();
  const v = await cache.get();
  const took = performance.now() - t0;
  assert.ok(took >= 45 && took < 150, `took ${took} ms`);
  assert.deepEqual(v, INFO_FALLBACK);
  assert.equal(f.calls, 1, "the get awaited the prime, no second call");
  await sleep(300);
  assert.equal((await cache.get()).model, "Opus 5.5");
  assert.equal(f.calls, 1);
});

test("unprimed: a fast getInfo gives the real value", async () => {
  const f = fakeInfo({ delayMs: 5 });
  const cache = createInfoCache({ getInfo: f.getInfo, primeTimeoutMs: 200, log: () => {} });
  cache.prime();
  const v = await cache.get();
  assert.equal(v.model, "Opus 5.5");
  assert.equal(f.calls, 1);
});

test("unprimed and the prime failed: the next get retries", async () => {
  const f = fakeInfo();
  f.fail = "boom";
  const logs = [];
  const cache = createInfoCache({ getInfo: f.getInfo, primeTimeoutMs: 50, log: (l) => logs.push(l) });
  await cache.prime();
  assert.deepEqual(logs, ["[bridge] info cache refresh failed: boom"]);
  f.fail = null;
  assert.equal((await cache.get()).model, "Opus 5.5");
  assert.equal(f.calls, 2);
});

test("only one refresh in flight under concurrent gets", async () => {
  const f = fakeInfo({ delayMs: 40 });
  const c = clock();
  const cache = createInfoCache({ getInfo: f.getInfo, ttlMs: 1000, primeTimeoutMs: 500, now: c.now, log: () => {} });
  // Unprimed: many concurrent gets share the one prime.
  const first = await Promise.all(Array.from({ length: 20 }, () => cache.get()));
  assert.ok(first.every((v) => v.n === 1));
  assert.equal(f.calls, 1);
  assert.equal(f.maxLive, 1);
  // Stale: many concurrent gets start one background refresh.
  c.t += 5000;
  await Promise.all(Array.from({ length: 20 }, () => cache.get()));
  await sleep(60);
  assert.equal(f.calls, 2);
  assert.equal(f.maxLive, 1);
});

// ── Router level ─────────────────────────────────────────────────────────────

async function buildApp(t, { infoCache, providers = [] }) {
  const app = express();
  app.use(
    "/api",
    createExtRouter({ hub: new Hub(), providers, getDefaultLocalProvider: () => ({}), infoCache }),
  );
  const fellThrough = [];
  app.use((req, res) => {
    fellThrough.push(`${req.method} ${req.originalUrl}`);
    res.status(200).json({ fellThrough: true });
  });
  const server = app.listen(0);
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { base: `http://127.0.0.1:${server.address().port}`, fellThrough };
}

test("/api/info is served from the cache with the official body shape", async (t) => {
  const f = fakeInfo();
  const cache = createInfoCache({ getInfo: f.getInfo, log: () => {} });
  await cache.prime();
  const { base, fellThrough } = await buildApp(t, { infoCache: cache });

  f.delayMs = 2000;
  const t0 = performance.now();
  const r = await fetch(`${base}/api/info`);
  assert.ok(performance.now() - t0 < 200);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await r.json(), { ...INFO, n: 1, extra: { expose: exposeType() } });

  const r2 = await fetch(`${base}/api/info?provider=claude`);
  assert.equal((await r2.json()).model, "Opus 5.5");
  assert.equal(f.calls, 1, "getInfo never on the request path");
  assert.deepEqual(fellThrough, []);
});

test("/api/info for another provider falls through to the official route", async (t) => {
  const f = fakeInfo();
  const cache = createInfoCache({ getInfo: f.getInfo, log: () => {} });
  const { base, fellThrough } = await buildApp(t, { infoCache: cache });
  const r = await fetch(`${base}/api/info?provider=codex`);
  assert.equal((await r.json()).fellThrough, true);
  assert.deepEqual(fellThrough, ["GET /api/info?provider=codex"]);
  assert.equal(f.calls, 0);
});

test("/api/info with a non-claude DEFAULT_PROVIDER falls through", async (t) => {
  const prev = process.env.DEFAULT_PROVIDER;
  process.env.DEFAULT_PROVIDER = "codex";
  t.after(() => {
    if (prev === undefined) delete process.env.DEFAULT_PROVIDER;
    else process.env.DEFAULT_PROVIDER = prev;
  });
  const f = fakeInfo();
  const cache = createInfoCache({ getInfo: f.getInfo, log: () => {} });
  const { base, fellThrough } = await buildApp(t, { infoCache: cache });
  await fetch(`${base}/api/info`).then((r) => r.json());
  assert.deepEqual(fellThrough, ["GET /api/info"]);
  assert.equal(f.calls, 0);
});

test("EVEN_BRIDGE_INFO_CACHE_MS=0 leaves /api/info to the official route", async (t) => {
  // server.mjs builds no cache when infoCacheMs() is 0 and passes infoCache: null.
  assert.equal(infoCacheMs({ EVEN_BRIDGE_INFO_CACHE_MS: "0" }), 0);
  const { base, fellThrough } = await buildApp(t, { infoCache: null });
  const r = await fetch(`${base}/api/info`);
  assert.equal((await r.json()).fellThrough, true);
  assert.deepEqual(fellThrough, ["GET /api/info"]);
});

test("/api/info?provider=<extended> still asks that provider", async (t) => {
  const f = fakeInfo();
  const cache = createInfoCache({ getInfo: f.getInfo, log: () => {} });
  const pi = { name: "pi", probe: () => false, getInfo: async () => ({ account: {}, model: "pi", version: "0.1", provider: "claude" }) };
  const { base } = await buildApp(t, { infoCache: cache, providers: [pi] });
  const r = await fetch(`${base}/api/info?provider=pi`);
  assert.deepEqual(await r.json(), { account: {}, model: "pi", version: "0.1", provider: "claude", extra: {} });
  assert.equal(f.calls, 0);
});
