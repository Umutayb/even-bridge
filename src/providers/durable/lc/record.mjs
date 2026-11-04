// The Durable record of a lets-code session (plan ruling 1). The session's
// Durable conversation never runs a model: it holds this document and write
// entries, and owns the one background task (`even.lc-run`) of a busy period.
// The full transcript is pi's own session file, which the record points at.
import { defineDoc } from "@earendil-works/pi-durable";

export const LC_SESSION_DOC = "even.lc-session";

/** Entry kinds, written as passive entries (`{kind, data: {text}}`), never as inputs. */
export const LC_USER = "lc.user";
export const LC_ANSWER = "lc.answer";
export const LC_TOOL = "lc.tool";
export const LC_ANSWER_MAX = 4000;

export const lcSessionInitial = () => ({
  piSessionId: null,
  piSessionFile: null,
  label: "",
  cwd: "",
  model: null,
  factory: false,
  mode: "ask",
  runs: 0,
  restarts: 0,
  lastLine: "",
  lastRequestId: null,
  childPid: null,
  sentTaskId: null, // the run task whose prompt lets-code accepted: a restart continues it with a cut-off prompt
  lastError: null, // { text, at }: lets-code refused the last factory start (cleared by the next toggle); { text, at, reason: "cap" }: the last run hit a cap (cleared by the next run)
  trusted: [], // factory worktrees the engine gave the project guard and pi trust (removed again by forget)
});

export const LcSessionDoc = defineDoc({
  kind: LC_SESSION_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: lcSessionInitial,
  checkpointWhen: () => true, // a small doc: every change is a complete base
});
