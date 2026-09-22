import test from "node:test";
import assert from "node:assert/strict";
import {
  claim,
  getOwner,
  forget,
  probeOwners,
  isExtendedProvider,
  _ownersSize,
} from "../src/ownership.mjs";

test("claim / getOwner / forget", () => {
  assert.equal(getOwner("s1"), null);
  claim("s1", "pi");
  assert.equal(getOwner("s1"), "pi");
  claim("s1", "claude-remote"); // re-claim wins
  assert.equal(getOwner("s1"), "claude-remote");
  forget("s1");
  assert.equal(getOwner("s1"), null);
});

test("empty ids are ignored", () => {
  claim("", "pi");
  assert.equal(_ownersSize(), 0);
  assert.equal(getOwner(""), null);
});

test("probeOwners: first prober claiming wins and caches", async () => {
  let rcCalls = 0;
  let piCalls = 0;
  const probers = [
    {
      name: "claude-remote",
      probe: async (sid) => {
        rcCalls++;
        return sid === "rc-1";
      },
    },
    {
      name: "pi",
      probe: async (sid) => {
        piCalls++;
        return sid === "pi-1";
      },
    },
  ];
  assert.equal(await probeOwners("rc-1", probers), "claude-remote");
  assert.equal(rcCalls, 1);
  assert.equal(piCalls, 0);
  // Cached — no further probes.
  assert.equal(await probeOwners("rc-1", probers), "claude-remote");
  assert.equal(rcCalls, 1);
  // Unknown id → both probed, null.
  assert.equal(await probeOwners("none", probers), null);
  assert.equal(rcCalls, 2);
  assert.equal(piCalls, 1);
});

test("probeOwners: a throwing prober does not break routing", async () => {
  const probers = [
    { name: "claude-remote", probe: async () => { throw new Error("upstream down"); } },
    { name: "pi", probe: async (sid) => sid === "pi-9" },
  ];
  assert.equal(await probeOwners("pi-9", probers), "pi");
  assert.equal(await probeOwners("x", probers), null);
});

test("isExtendedProvider", () => {
  assert.ok(isExtendedProvider("claude-remote"));
  assert.ok(isExtendedProvider("pi"));
  assert.ok(!isExtendedProvider("claude"));
  assert.ok(!isExtendedProvider("codex"));
});
