// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/rpc/client.ts
// See NOTICE.md.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { LineSplitter } from "./framing.mjs";

// pi RPC dialog methods that block the agent (from src/rpc/types.ts).
const DIALOG_METHODS = new Set(["confirm", "select", "input", "editor"]);

/**
 * Spawns and talks to one `pi --mode rpc` subprocess.
 *
 * Responsibilities (transport only — no even-terminal semantics here):
 *  - strict LF-only JSONL framing
 *  - command/response correlation by `id`
 *  - re-emit every inbound event for higher layers
 *  - surface extension_ui_request dialogs and let callers respond by id
 */
export class PiRpcClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.child = null;
    this.splitter = new LineSplitter();
    this.pending = new Map();
    this.closed = false;
  }

  get running() {
    return !!this.child && !this.closed;
  }

  start() {
    if (this.running) return;
    const args = ["--mode", "rpc"];
    if (this.opts.resume) args.push("--session", this.opts.resume);
    if (this.opts.name) args.push("--name", this.opts.name);
    if (this.opts.model) args.push("--model", this.opts.model);
    for (const a of this.opts.extraArgs ?? []) args.push(a);

    const env = { ...process.env, ...(this.opts.env ?? {}) };
    const child = spawn(this.opts.bin ?? "pi", args, {
      cwd: this.opts.cwd || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk) => {
      for (const line of this.splitter.push(chunk.toString())) this.handleLine(line);
    });

    const errSplitter = new LineSplitter();
    child.stderr.on("data", (chunk) => {
      for (const line of errSplitter.push(chunk.toString())) {
        this.opts.onStderr?.(line);
      }
    });

    child.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error(`pi exited (code=${code} signal=${signal}) before responding`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    child.on("error", (err) => {
      this.closed = true;
      this.emit("error", err);
    });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("malformed", line);
      return;
    }

    if (msg.type === "response") {
      const r = msg;
      if (r.id && this.pending.has(r.id)) {
        this.pending.get(r.id).resolve(r);
        this.pending.delete(r.id);
      }
      this.emit("response", r);
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.emit("ui_request", msg);
      return;
    }

    // Everything else is an agent event.
    this.emit("event", msg);
  }

  /** Send a command. Returns the correlated response (dialog/fire-and-forget aside). */
  send(cmd, timeoutMs = 30_000) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("pi process not running"));
    }
    const id = cmd.id ?? randomUUID();
    const payload = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command "${cmd.type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeLine(payload);
    });
  }

  /** Fire a command without awaiting a correlated response. */
  fire(cmd) {
    if (!this.child || this.closed) return;
    this.writeLine({ ...cmd, id: cmd.id ?? randomUUID() });
  }

  /** Respond to an extension_ui_request dialog. */
  respondUi(res) {
    this.writeLine(res);
  }

  writeLine(obj) {
    this.child?.stdin.write(JSON.stringify(obj) + "\n");
  }

  static isDialog(req) {
    return DIALOG_METHODS.has(req.method);
  }

  async stop() {
    if (!this.child) return;
    this.closed = true;
    this.child.stdin.end();
    const child = this.child;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = null;
  }
}
