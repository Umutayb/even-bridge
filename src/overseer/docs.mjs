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
/** notify calls one overseer run may make (an injected loop cannot flood the outbox and evict late answers). */
export const NOTIFY_PER_RUN = 3;
/** Settled asks remembered after they left `pending` (a retried requestId never lands in the outbox twice). */
export const ASKS_DONE_KEEP = 200;
export const OUTBOX_KINDS = Object.freeze(["answer", "notify", "action", "checkin", "system"]);
export { ROOT_CONVERSATION_ID };

/** A hand-off's tag (`<source>:<key>`, e.g. "ideate:bees") and agent label; the tag routes results back. */
export const HANDOFF_TAG_RE = /^[a-z]{1,16}:[a-z0-9][a-z0-9-]{0,39}$/;
export const HANDOFF_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const HANDOFF_TTL_S = Object.freeze({ min: 300, max: 43200 });
/** The only model a hand-off agent may run on (the private default). */
export const HANDOFF_MODEL = "qwen";
/** How long a hand-off's tag stays usable for `notify` (its results come in overnight). */
export const HANDOFF_TAG_MS = 24 * 3600 * 1000;
export const HANDOFFS_KEEP = 20;

const latest = { scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => true };

export const OverseerNotes = defineDoc({ kind: "even.overseer.notes", version: 1, ...latest, initial: () => ({ text: "" }) });

export const OverseerOutbox = defineDoc({
  kind: "even.overseer.outbox",
  version: 1,
  ...latest,
  initial: () => ({ seq: 0, readUpTo: 0, items: [], notifyRun: null }),
});

export const OverseerAsks = defineDoc({
  kind: "even.overseer.asks",
  version: 1,
  ...latest,
  // done: requestIds settled (answered in time or moved to the outbox); delivered: those moved to the outbox.
  initial: () => ({ pending: [], done: [], delivered: [] }),
});

/**
 * Hand-offs (EVEN_BRIDGE_OVERSEER_HANDOFF=1): a told instruction that carries a hand-off request
 * `{tag, label, cwd, ttlS, requestId, submissionId, at}`; a start the overseer proposes while working
 * on that submission is held to it (its folder, qwen, at most ttlS) and its results may carry the tag.
 */
export const OverseerHandoffs = defineDoc({ kind: "even.overseer.handoffs", version: 1, ...latest, initial: () => ({ items: [] }) });

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
