// The overseer's constants and its three documents on the root conversation
// (EVEN_BRIDGE_OVERSEER_ENABLE=1 only; nothing here is loaded with the flag off).
//   even.overseer.notes   its own notes (≤ 16 KB), read and written by its tools
//   even.overseer.outbox  short items Even AI reads ("what's new"): answers that came late, notifies
//   even.overseer.asks    `overseer_ask` submissions not answered within the wait (plan ruling 7)
import { defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

export const OVERSEER_SID = "dur-overseer";
export const OVERSEER_TITLE = "Overseer";
export const OVERSEER_MAX_TURNS = 12;
export const READ_CAP_BYTES = 4096;
export const NOTES_CAP_BYTES = 16384;
export const OUTBOX_KEEP = 50;
export const ASK_WAIT_MAX_MS = 15000;
export const NOTIFY_MAX_CHARS = 500;
/** Settled asks remembered after they left `pending` (a retried requestId never lands in the outbox twice). */
export const ASKS_DONE_KEEP = 200;
export const OUTBOX_KINDS = Object.freeze(["answer", "notify", "action", "checkin", "system"]);
export { ROOT_CONVERSATION_ID };

const latest = { scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => true };

export const OverseerNotes = defineDoc({ kind: "even.overseer.notes", version: 1, ...latest, initial: () => ({ text: "" }) });

export const OverseerOutbox = defineDoc({
  kind: "even.overseer.outbox",
  version: 1,
  ...latest,
  initial: () => ({ seq: 0, readUpTo: 0, items: [] }),
});

export const OverseerAsks = defineDoc({
  kind: "even.overseer.asks",
  version: 1,
  ...latest,
  initial: () => ({ pending: [], done: [] }),
});

/**
 * Append one item to an outbox draft (inside a commit): the next seq, the newest OUTBOX_KEEP kept.
 * @returns {object} the item
 */
export function pushOutbox(box, { kind, text, requestId, tag, at = Date.now() }) {
  box.seq = (box.seq ?? 0) + 1;
  const item = { seq: box.seq, at, kind, text: String(text ?? "") };
  if (requestId != null) item.requestId = String(requestId);
  if (tag != null) item.tag = String(tag);
  box.items ??= [];
  box.items.push(item);
  while (box.items.length > OUTBOX_KEEP) box.items.shift();
  return item;
}

/** Bytes of `s` as UTF-8. */
export const bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");
