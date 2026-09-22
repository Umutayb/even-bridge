#!/usr/bin/env node
// Verify the installed @evenrealities/even-terminal still exports everything
// even-bridge depends on. Run after upgrading the dependency:
//
//   node scripts/check-upstream.mjs
//
// Exits non-zero and lists missing exports if the upstream dist changed.

const REQUIRED = {
  "@evenrealities/even-terminal/dist/routes/events.js": [
    "default",
    "pushMessage",
    "getMessages",
    "broadcast",
    "clientCount",
    "sessionHasClients",
  ],
  "@evenrealities/even-terminal/dist/routes/core.js": [
    "default",
    "getProvider",
    "claudeSyncTransport",
    "emitBridgeMessage",
    "INFO_AUTH_ERROR",
  ],
  "@evenrealities/even-terminal/dist/session.js": [
    "SUPPORTED_PROVIDERS",
    "getDefaultProvider",
    "isProvider",
    "parseProvider",
  ],
  "@evenrealities/even-terminal/dist/claude-sync/hook-receiver.js": ["handleHookRequest"],
  "@evenrealities/even-terminal/dist/startup/common.js": [
    "CODEX_APP_SERVER_PORT",
    "printServerBanner",
    "resolveHost",
    "stopCodexAppServer",
  ],
  "@evenrealities/even-terminal/dist/startup/instance.js": [
    "writeInstancePidfile",
    "removeInstancePidfile",
  ],
  "@evenrealities/even-terminal/dist/expose/run.js": ["startExposeProvider"],
  "@evenrealities/even-terminal/dist/expose/registry.js": ["getExposeProviderNames"],
  "@evenrealities/even-terminal/dist/logger.js": ["installTimestampLogging"],
  "@evenrealities/even-terminal/dist/http-log.js": ["redactTokenQueryParam"],
  "@evenrealities/even-terminal/bin/config.js": [
    "loadConfig",
    "saveConfig",
    "createDefaultConfig",
    "generateToken",
    "resolveConfigPath",
    "resolveUserPath",
    "resolveStartupEnvironment",
    "formatConfig",
  ],
};

let failed = 0;
for (const [mod, exports] of Object.entries(REQUIRED)) {
  let m;
  try {
    m = await import(mod);
  } catch (err) {
    console.error(`FAIL  ${mod}: cannot import — ${err.message}`);
    failed++;
    continue;
  }
  const missing = exports.filter((e) => !(e in m));
  if (missing.length > 0) {
    console.error(`FAIL  ${mod}: missing exports: ${missing.join(", ")}`);
    failed++;
  } else {
    console.log(`ok    ${mod}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} module(s) missing expected exports — check dist/routes/core.js internals before shipping.`);
  process.exit(1);
}
console.log("\nAll upstream exports present.");
