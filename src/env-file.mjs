// Live bridge settings: ~/.even-terminal/bridge.env (override the path with
// EVEN_BRIDGE_ENV_FILE). KEY=VALUE lines, # comments, optional quotes.
//
// Loaded at startup and re-read whenever the file changes, so switching the
// glasses' new-session provider or Claude Code model is a file edit with no
// restart and no sudo. Values here win over the systemd unit's Environment=.
// A key removed from the file falls back to the value the process started
// with. Live (read per request / per launch):
//   EVEN_BRIDGE_NEW_SESSION_PROVIDER   claude | pi | claude-remote
//   EVEN_BRIDGE_CC_MODEL               model for glasses-spawned Claude Code
// Settings read once at startup (EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE,
// EVEN_BRIDGE_CC_PERMISSION_MODE, EVEN_BRIDGE_PI_*) still need a restart: kill the bridge, systemd restarts it.
import { readFileSync, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultEnvFilePath(env = process.env) {
  return env.EVEN_BRIDGE_ENV_FILE || join(homedir(), ".even-terminal", "bridge.env");
}

export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** Apply `values` to env; keys applied earlier but now absent revert to `base`. */
export function applyEnvValues(values, { env = process.env, base, applied }) {
  const changed = [];
  for (const k of [...applied]) {
    if (k in values) continue;
    if (base[k] === undefined) delete env[k];
    else env[k] = base[k];
    applied.delete(k);
    changed.push(k);
  }
  for (const [k, v] of Object.entries(values)) {
    if (!(k in base)) base[k] = env[k];
    if (env[k] !== v) changed.push(k);
    env[k] = v;
    applied.add(k);
  }
  return changed;
}

export function startEnvFile({ path = defaultEnvFilePath(), env = process.env, log = console.log, watch = true } = {}) {
  const base = {};
  const applied = new Set();
  const load = (why) => {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { /* missing file = no overrides */ }
    const changed = applyEnvValues(parseEnvText(text), { env, base, applied });
    if (changed.length) {
      log(`[bridge] ${why} ${path}: ${changed.map((k) => `${k}=${env[k] ?? "(unset)"}`).join(" ")}`);
    }
  };
  load("loaded");
  if (watch) watchFile(path, { interval: 2000, persistent: false }, () => load("reloaded"));
  return { path, reload: () => load("reloaded") };
}
