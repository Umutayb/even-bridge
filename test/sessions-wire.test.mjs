// The phone's session list: every row's `timestamp` is an ISO-8601 string on the wire (official providers send
// strings; durable/overseer rows carry epoch ms internally). Field failure 2026-11-05: the Terminal app listed no
// sessions once the overseer row (epoch ms, pinned first) was in the list.
import assert from "node:assert/strict";
import { test } from "node:test";

import { wireSession } from "../src/ext-router.mjs";

test("epoch-ms timestamps become ISO strings, other fields pass through", () => {
  const row = { id: "dur-overseer", title: "Overseer", timestamp: 1793897256411, provider: "claude", status: "idle" };
  const out = wireSession(row);
  assert.equal(out.timestamp, new Date(1793897256411).toISOString());
  assert.equal(out.id, "dur-overseer");
  assert.equal(out.status, "idle");
  assert.equal(row.timestamp, 1793897256411, "the internal row is not mutated");
});

test("ISO strings and odd values are left as they are", () => {
  const iso = { id: "a", timestamp: "2026-11-05T08:40:16.110Z" };
  assert.equal(wireSession(iso).timestamp, "2026-11-05T08:40:16.110Z");
  assert.equal(Number.isNaN(wireSession({ id: "b", timestamp: NaN }).timestamp), true);
  assert.equal(wireSession({ id: "c" }).timestamp, undefined);
  assert.equal(wireSession(null), null);
});
