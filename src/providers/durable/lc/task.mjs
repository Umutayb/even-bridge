// `even.lc-run`: one background task per busy period of a lets-code session
// (plan ruling 1). Its only phase drives the child through the engine; a
// restart of the bridge reruns the phase from its top with the next attempt,
// so the engine re-spawns the child with `--session <file>` and sends one
// cut-off prompt (or `/factory resume <id>`). A child that crashes while the
// bridge keeps running is retried the same way, in the same invocation.
import { defineTask } from "@earendil-works/pi-durable";

export const LC_RUN_TASK = "even.lc-run";
export const LC_RESTART_LIMIT = 5;
export const LC_CUTOFF_PROMPT =
  "You were cut off by a restart of the bridge. Your last tool call may have no result; run it again if you still need it. " +
  "Check the state of your work (files, tests, git status) and continue the task.";
export const LC_CRASH_PROMPT =
  "Your lets-code process exited unexpectedly and was started again. Your last tool call may have no result; run it again if you still need it. " +
  "Check the state of your work (files, tests, git status) and continue the task.";
export const LC_RESTART_LIMIT_MESSAGE = `lets-code run stopped: restarted ${LC_RESTART_LIMIT} times in a row`;

/** The child died mid-turn (not stopped by us): the run is retried. */
export const LC_EXIT = "LC_EXIT";
/** The engine stopped the run at a per-run cap (turns, repeated tool call): failed, never retried; the engine already went idle. */
export const LC_CAP = "LC_CAP";

/**
 * @param {{ drive(sid, {text, attempt}, signal): Promise<{lastLine: string}>, abortChild(sid): Promise<void>|void,
 *   runFailed(sid, message: string): void }} engine
 */
export function createLcRunTask(engine) {
  return defineTask({
    name: LC_RUN_TASK,
    version: 1,
    initial: () => ({ phase: "drive", attempt: 0 }),
    phases: {
      drive: async (task, runtime, context) => {
        const { sid, text } = task.input;
        let attempt = task.state.checkpoint.attempt;
        for (;;) {
          attempt += 1;
          if (attempt > LC_RESTART_LIMIT + 1) {
            engine.runFailed(sid, LC_RESTART_LIMIT_MESSAGE);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: LC_RESTART_LIMIT_MESSAGE } } }), context);
            return;
          }
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "drive", attempt } }), context);
          try {
            const { lastLine } = await engine.drive(sid, { text, attempt, taskId: task.id }, runtime.signal);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { lastLine: lastLine ?? "" } } }), context);
            return;
          } catch (err) {
            if (runtime.signal.aborted) throw err; // closing or aborted: the rerun / abort handler takes over
            if (err?.code === LC_EXIT) continue; // a crash: next attempt
            if (err?.code === LC_CAP) {
              await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: err.message } } }), context);
              return;
            }
            const message = `lets-code run failed: ${err?.message ?? err}`;
            engine.runFailed(sid, message);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), context);
            return;
          }
        }
      },
    },
    abort: async (task, runtime, context) => {
      try {
        await engine.abortChild(task.input.sid);
      } finally {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      }
    },
  });
}
