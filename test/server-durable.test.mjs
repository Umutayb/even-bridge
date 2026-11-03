import test from "node:test";
import assert from "node:assert/strict";
import { durableEnabled, durableOptions } from "../src/server.mjs";

test("durable is off unless EVEN_BRIDGE_DURABLE_ENABLE=1", () => {
  assert.equal(durableEnabled({}), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "0" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "true" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), true);
  assert.equal(durableOptions({}, { cwd: "/p" }), null, "flag unset: no durable provider is built");
});

test("durable options come from the env; CWDS is colon-separated", () => {
  assert.deepEqual(
    durableOptions(
      {
        EVEN_BRIDGE_DURABLE_ENABLE: "1",
        EVEN_BRIDGE_DURABLE_STORE: "/tmp/d/durable.sqlite",
        EVEN_BRIDGE_DURABLE_MODELS: "/tmp/d/models.json",
        EVEN_BRIDGE_DURABLE_CWDS: "~/github: ~/sandbox/agents::",
      },
      { cwd: "/home/u/github/proj" },
    ),
    {
      defaultCwd: "/home/u/github/proj",
      allowedCwds: ["~/github", "~/sandbox/agents"],
      storePath: "/tmp/d/durable.sqlite",
      modelsPath: "/tmp/d/models.json",
    },
  );
  // Unset store/models: the provider's own defaults apply (keys absent, not undefined).
  assert.deepEqual(durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }, { cwd: "/p" }), {
    defaultCwd: "/p",
    allowedCwds: [],
  });
});
