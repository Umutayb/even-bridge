#!/usr/bin/env node
// even-bridge CLI.
//
// Thin entry: reuses the OFFICIAL config machinery (bin/config.js exports —
// same ~/.even-terminal/config.json, same wizard via `even-terminal config`)
// and then boots src/server.mjs. All stock even-terminal flags work unchanged;
// bridge flags add the extension providers.
//
//   even-bridge                 start the bridge (config from ~/.even-terminal/config.json)
//   even-bridge init            non-interactively create a default config
//
// Bridge flags:
//   --rc-url <url>      claude-remote bridge terminal host (default http://127.0.0.1:8791)
//   --rc-token <token>  token for the RC bridge (default: ~/.config/claude-remote-terminal/bridge-token)
//   --no-rc             disable claude-remote sessions
//   --no-pi             disable pi sessions
//   --pi-bin <bin>      pi executable (default: pi)
//   --pi-model <model>  default pi model (default: pi's default)
//   --no-pi-all-cwds    list pi sessions for the project dir only (default: all)
//   --pi-agent-dir <d>  pi agent dir (default: ~/.pi/agent)

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  resolveConfigPath,
  loadConfig,
  saveConfig,
  createDefaultConfig,
  formatConfig,
  resolveStartupEnvironment,
  resolveUserPath,
} from "@evenrealities/even-terminal/bin/config.js";
import { getExposeProviderNames } from "@evenrealities/even-terminal/dist/expose/registry.js";
import { SUPPORTED_PROVIDERS } from "@evenrealities/even-terminal/dist/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exposeProviderNames = getExposeProviderNames();

function applyResolvedEnvironment(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function cmdInit(argv) {
  const configPath = resolveConfigPath(argv.config);
  if (existsSync(configPath)) {
    console.log(`Config already exists at ${configPath}.`);
    return;
  }
  const config = createDefaultConfig(resolveUserPath(argv.cwd ?? process.cwd()));
  saveConfig(configPath, config, exposeProviderNames);
  console.log(`Created ${configPath}\n`);
  console.log(formatConfig(config, configPath));
  console.log("\nPair the phone with the token above (or restart to print the QR code).");
}

async function cmdStart(argv) {
  const configPath = resolveConfigPath(argv.config);
  let config = loadConfig(configPath, exposeProviderNames);
  if (!config) {
    throw new Error(
      `No config found at ${configPath}.\n` +
        `  Run:  even-terminal config   (official interactive wizard)\n` +
        `  or:   even-bridge init        (non-interactive defaults)`
    );
  }

  // Stock startup environment (flags > env > config), exactly like the
  // official CLI.
  applyResolvedEnvironment(
    resolveStartupEnvironment(config, argv, process.env)
  );

  if (argv.verbose) process.env.VERBOSE = "1";
  if (argv["allow-cors"]) process.env.EVEN_ALLOW_CORS = "1";
  if (argv["use-original-claude"]) process.env.USE_ORIGINAL_CLAUDE = "1";

  // Bridge extension flags (flags > env).
  if (argv["rc-url"]) process.env.EVEN_BRIDGE_RC_URL = argv["rc-url"];
  if (argv["rc-token"]) process.env.EVEN_BRIDGE_RC_TOKEN = argv["rc-token"];
  if (argv.rc === false) process.env.EVEN_BRIDGE_RC_ENABLE = "0";
  if (argv.pi === false) process.env.EVEN_BRIDGE_PI_ENABLE = "0";
  if (argv["pi-bin"]) process.env.EVEN_BRIDGE_PI_BIN = argv["pi-bin"];
  if (argv["pi-model"]) process.env.EVEN_BRIDGE_PI_MODEL = argv["pi-model"];
  if (argv["pi-all-cwds"] === false) process.env.EVEN_BRIDGE_PI_ALL_CWDS = "0";
  if (argv["pi-agent-dir"]) process.env.EVEN_BRIDGE_PI_AGENT_DIR = argv["pi-agent-dir"];

  // Log file (the official logger reads --log-file from process.argv).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = argv["log-file"] || `even-bridge-${stamp}.log`;
  process.argv.push("--log-file", resolve(filename));

  const { startServer } = await import("../src/server.mjs");
  await startServer({
    flags: argv,
    cwd: process.env.PROJECT_DIR || process.cwd(),
  });
  // Keep the process alive (the server runs until SIGINT/SIGTERM).
  await new Promise(() => {});
}

yargs(hideBin(process.argv))
  .scriptName("even-bridge")
  .usage("$0 [command]")
  .command(
    "$0",
    "Start the bridge (default)",
    (y) =>
      y
        .option("port", { alias: "p", type: "number", describe: "Server port" })
        .option("token", { alias: "t", type: "string", describe: "Override the persistent auth token for this run" })
        .option("name", { alias: "n", type: "string", describe: "Client display name" })
        .option("cwd", { alias: "d", type: "string", describe: "Project directory (where local sessions live)" })
        .option("provider", { type: "string", choices: SUPPORTED_PROVIDERS, describe: "Default AI provider" })
        .option("config", { type: "string", describe: "Use another config file (default: ~/.even-terminal/config.json)" })
        .option("lan", { type: "boolean", describe: "Use the detected LAN address" })
        .option("tailscale", { type: "boolean", describe: "Use Tailscale IPv4 address instead of LAN" })
        .option("interface", { alias: ["i", "if"], type: "string", describe: "Bind to the IPv4 address of the named network interface" })
        .option("allow-cors", { type: "boolean", describe: "Allow cross-origin browser requests" })
        .option("expose", { type: "string", array: true, choices: exposeProviderNames, describe: "Quick public expose provider" })
        .option("log-file", { type: "string", describe: "Write logs to a file" })
        .option("verbose", { type: "boolean", describe: "Print raw diagnostics to stdout" })
        .option("use-original-claude", { type: "boolean", describe: "Use the original Claude SDK provider without terminal/app synchronization" })
        .option("claude-allowed-tools", { type: "string", describe: "Replace the default Claude SDK auto-approved tool list (comma-separated, or 'none')" })
        .option("rc-url", { type: "string", describe: "claude-remote bridge terminal host URL (default http://127.0.0.1:8791)" })
        .option("rc-token", { type: "string", describe: "Token for the claude-remote bridge" })
        .option("rc", { type: "boolean", default: true, describe: "Enable claude-remote (RC) sessions" })
        .option("pi", { type: "boolean", default: true, describe: "Enable pi sessions" })
        .option("pi-bin", { type: "string", describe: "pi executable (default: pi)" })
        .option("pi-model", { type: "string", describe: "Default pi model" })
        .option("pi-all-cwds", { type: "boolean", default: true, describe: "List pi sessions across all project dirs" })
        .option("pi-agent-dir", { type: "string", describe: "pi agent dir (default ~/.pi/agent)" }),
    (argv) => cmdStart(argv)
  )
  .command(
    "init",
    "Create a default config (non-interactive)",
    (y) =>
      y
        .option("config", { type: "string", describe: "Config file path" })
        .option("cwd", { alias: "d", type: "string", describe: "Default project directory" }),
    (argv) => cmdInit(argv)
  )
  .demandCommand(0, "start the bridge with no command")
  .recommendCommands()
  .strictCommands()
  .fail((msg, err, yargs) => {
    if (err) throw err;
    console.error(msg);
    yargs.showHelp();
    process.exit(1);
  })
  .help()
  .alias("h", "help")
  .version()
  .parserConfiguration({ "camel-case-expansion": true })
  .parse();
