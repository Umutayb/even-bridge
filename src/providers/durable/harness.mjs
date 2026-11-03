// Opens the one Durable harness the bridge owns: SQLite-backed storage,
// lets-code's models, the installed extension registry and a per-conversation
// execution environment. `resume()` restarts whatever the last process left
// unfinished, so a bridge restart continues runs instead of losing them.
//
// Telemetry: pi-durable 1.5.0 only reports through a host-supplied
// `HarnessOptions.telemetry` adapter (absent = no-op) and reads no env flag;
// PI_TELEMETRY=0 is still set so tool shells and child pi processes inherit it.
// Attribution headers to providers are switched off (`identity.attribution: null`).

import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * @param {object} o
 * @param {string} [o.storePath] Durable SQLite file (ignored when `storage` is given).
 * @param {object} [o.storage] a ready Storage (tests: `new MemoryStorage()`).
 * @param {import("@earendil-works/pi-ai").Models} o.models
 * @param {object} o.registry `createRegistry()` with the extensions installed.
 * @param {Function} [o.envFor] `HarnessOptions.env`: ({conversationId, cwd}) → ExecutionEnv.
 * @param {boolean} [o.telemetryOff=true]
 * @param {object} [o.settings] extra HarnessSettings merged over the defaults.
 * @param {(report: object) => void} [o.onReport]
 */
export async function openDurable({ storePath, storage, models, registry, envFor, telemetryOff = true, settings = {}, onReport } = {}) {
  if (telemetryOff) process.env.PI_TELEMETRY = "0";
  if (!storage) {
    if (!storePath) throw new Error("openDurable: storePath or storage is required");
    storage = await openNodeSqliteStorage(storePath, { busyTimeoutMs: 5000 });
  }
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: envFor,
      identity: { attribution: null },
      settings: { ...settings, compaction: { enabled: true, ...(settings.compaction ?? {}) } },
      ...(onReport ? { onReport } : {}),
    },
    ctx,
  );
  harness.resume();
  let closing;
  return {
    harness,
    ctx,
    close() {
      closing ??= harness.close(ctx);
      return closing;
    },
  };
}
