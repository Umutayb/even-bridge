#!/usr/bin/env node
// Import every even-bridge module to catch bad relative import paths early
// (node --test only loads modules that tests exercise).

const MODULES = [
  "../src/ownership.mjs",
  "../src/rc-transcripts.mjs",
  "../src/hub.mjs",
  "../src/upstream-pump.mjs",
  "../src/ext-router.mjs",
  "../src/providers/claude-remote.mjs",
  "../src/providers/pi/framing.mjs",
  "../src/providers/pi/summarize.mjs",
  "../src/providers/pi/session-files.mjs",
  "../src/providers/pi/rpc-client.mjs",
  "../src/providers/pi/session.mjs",
  "../src/providers/pi/provider.mjs",
  "../src/providers/durable/models.mjs",
  "../src/providers/durable/harness.mjs",
  "../src/providers/durable/sessions.mjs",
  "../src/providers/durable/wire.mjs",
  "../src/providers/durable/guard.mjs",
  "../src/providers/durable/guard-ext.mjs",
  "../src/providers/durable/lc/launch.mjs",
  "../src/providers/durable/lc/session.mjs",
  "../src/providers/durable/lc/record.mjs",
  "../src/providers/durable/lc/task.mjs",
  "../src/providers/durable/lc/guard-core.mjs",
  "../src/providers/durable/lc/engine.mjs",
  "../src/providers/durable/agent-files.mjs",
  "../src/providers/durable/subagent.mjs",
  "../src/providers/durable/provider.mjs",
  "../src/server.mjs",
];

let failed = 0;
for (const m of MODULES) {
  try {
    await import(m);
    console.log(`ok    ${m}`);
  } catch (err) {
    console.error(`FAIL  ${m}: ${err.message}`);
    failed++;
  }
}
process.exit(failed > 0 ? 1 : 0);
