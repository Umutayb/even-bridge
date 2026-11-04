import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FACTORY_TITLE,
  LC_CONFIRM_DENY_MS,
  LcSession,
  MANDATE_ALLOW,
  MANDATE_DENY,
  MANDATE_TITLE,
  dialogKind,
  FACTORY_EXPERTS_ERROR,
} from "../src/providers/durable/lc/session.mjs";

const FAKE = fileURLToPath(new URL("./helpers/fake-pi-rpc.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const readLog = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function setup(t, { clients = 0, t0 = 1_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lc-session-"));
  const logFile = join(dir, "fake.log");
  const frames = [];
  const dialogs = [];
  const notes = [];
  let clock = t0;
  let clientCount = clients;
  const session = new LcSession((sid, f) => frames.push({ sid, ...f }), {
    sid: "dur-x",
    bin: FAKE,
    cwd: dir,
    envExact: true,
    env: { PATH: process.env.PATH, FAKE_PI_LOG: logFile },
    extraArgs: ["--session-dir", join(dir, "sessions")],
    clientCount: () => clientCount,
    onDialog: (kind, req) => dialogs.push({ kind, req }),
    onNotify: (text) => notes.push(text),
    now: () => clock,
    log: { warn() {}, log() {}, error() {} },
  });
  await session.start();
  t.after(async () => {
    await session.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    session,
    frames,
    dialogs,
    notes,
    log: () => readLog(logFile),
    setClock: (v) => (clock = v),
    setClients: (n) => (clientCount = n),
    t0,
  };
}

test("dialogKind classifies the lets-code dialogs", () => {
  assert.equal(dialogKind({ method: "select", title: "mandate (ask): sudo apt install x\n\nAllow?", options: ["Allow once", "Allow for this session", "Deny"] }), "confirm");
  assert.equal(dialogKind({ method: "select", title: "Factory 20261103-093221-c129: the developer's plan\n\nbody", options: ["Approve", "Edit", "Stop"] }), "factory");
  assert.equal(dialogKind({ method: "select", title: "Pick one", options: ["a", "b"] }), "question");
  assert.equal(dialogKind({ method: "editor", title: "Acceptance criteria" }), "freeform");
  assert.equal(dialogKind({ method: "notify", message: "x" }), null);
  assert.match("mandate (ask): x", MANDATE_TITLE);
  assert.deepEqual("Factory 20261103-093221-c129: acceptance criteria\n\nbody".match(FACTORY_TITLE).slice(1), ["20261103-093221-c129", "acceptance criteria"]);
  assert.equal(LC_CONFIRM_DENY_MS, 600_000);
  assert.equal(MANDATE_ALLOW, "Allow once");
  assert.equal(MANDATE_DENY, "Deny");
});

test("factory checkpoints are held, Edit is hidden and no Cancel is added", async (t) => {
  const s = await setup(t);
  await s.session.run("FACTORY");
  await until(() => s.frames.some((f) => f.type === "user_question"));
  const q = s.frames.find((f) => f.type === "user_question");
  assert.equal(q.sid, "dur-x");
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ["Confirm", "Stop"]);
  assert.deepEqual(s.dialogs.map((d) => d.kind), ["factory"]);
  assert.deepEqual(s.session.openDialogs().map((d) => d.kind), ["factory"]);
  assert.equal(s.session.sweepDialogs(s.t0 + 3_600_000), 0, "never auto-answered");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.log().filter((c) => c.type === "extension_ui_response").length, 0);
  assert.equal(s.session.status, "awaiting");
  // An answer by option reaches the child.
  s.session.respondQuestion("Confirm");
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  assert.equal(s.log().find((c) => c.type === "extension_ui_response").value, "Confirm");
});

test("a mandate ask reaches the phone as yes/no", async (t) => {
  const s = await setup(t);
  await s.session.run("ASK");
  await until(() => s.frames.some((f) => f.type === "permission_request"));
  const pr = s.frames.find((f) => f.type === "permission_request");
  assert.deepEqual(pr.options, [{ text: "Yes", key: "allow" }, { text: "No", key: "deny" }]);
  assert.match(pr.description, /write outside the project: \/x\/out\.txt/);
  assert.equal(s.frames.filter((f) => f.type === "user_question").length, 0);
  assert.equal(s.session.respondPermission("allow"), true);
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  const r1 = s.log().find((c) => c.type === "extension_ui_response");
  assert.equal(r1.value, "Allow once");
  assert.equal(r1.id, pr.toolUseId);
  await until(() => s.frames.some((f) => f.type === "result"));
  await s.session.run("ASK");
  await until(() => s.frames.filter((f) => f.type === "permission_request").length === 2);
  assert.equal(s.session.respondPermission("allowAlways"), true, "allow for the session is never offered remotely");
  await until(() => s.log().filter((c) => c.type === "extension_ui_response").length === 2);
  assert.equal(s.log().filter((c) => c.type === "extension_ui_response")[1].value, "Allow once");
  await until(() => s.frames.filter((f) => f.type === "result").length === 2);
  await s.session.run("ASK");
  await until(() => s.frames.filter((f) => f.type === "permission_request").length === 3);
  s.session.respondPermission("deny");
  await until(() => s.log().filter((c) => c.type === "extension_ui_response").length === 3);
  assert.equal(s.log().filter((c) => c.type === "extension_ui_response")[2].value, "Deny");
  assert.equal(s.session.respondPermission("deny"), false, "nothing pending");
});

test("nobody watching: a mandate ask is denied after 10 minutes", async (t) => {
  const s = await setup(t, { clients: 0 });
  await s.session.run("ASK");
  await until(() => s.frames.some((f) => f.type === "permission_request"));
  assert.equal(s.session.sweepDialogs(s.t0 + 599_000), 0);
  assert.equal(s.session.sweepDialogs(s.t0 + 600_000), 1);
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  assert.equal(s.log().find((c) => c.type === "extension_ui_response").value, "Deny");
  const res = s.frames.find((f) => f.type === "permission_result");
  assert.equal(res.decision, "denied");
  assert.equal(s.session.openDialogs().length, 0);
});

test("a watched mandate ask is never auto-denied", async (t) => {
  const s = await setup(t, { clients: 1 });
  await s.session.run("ASK");
  await until(() => s.frames.some((f) => f.type === "permission_request"));
  assert.equal(s.session.sweepDialogs(s.t0 + 7_200_000), 0);
  assert.equal(s.session.openDialogs().length, 1);
});

test("editor dialogs are cancelled", async (t) => {
  const s = await setup(t);
  await s.session.run("EDITOR");
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  const r = s.log().find((c) => c.type === "extension_ui_response");
  assert.equal(r.cancelled, true);
  await until(() => s.frames.some((f) => f.type === "result"));
  assert.equal(s.frames.filter((f) => f.type === "user_question" || f.type === "permission_request").length, 0);
  assert.ok(!s.frames.some((f) => f.type === "text_delta" && /Acceptance criteria/.test(f.text)), "the editor title is not shown as text");
});

test("notify texts reach onNotify", async (t) => {
  const s = await setup(t);
  const res = await s.session.command("/mode orchestration");
  assert.equal(res.data.disposition, "handled");
  await until(() => s.notes.includes("mode: orchestration"));
});

test("frames carry the bridge sid, and get_state gives the session file", async (t) => {
  const s = await setup(t);
  assert.ok(s.session.sessionId);
  assert.match(s.session.sessionFile, /sessions\/.+\.jsonl$/);
  assert.ok(!existsSync(s.session.sessionFile), "written lazily, at the first prompt");
  await s.session.run("hello");
  await until(() => s.frames.some((f) => f.type === "result"));
  assert.ok(s.frames.every((f) => f.sid === "dur-x"));
  const idle = s.frames.filter((f) => f.type === "status" && f.state === "idle");
  assert.ok(idle.every((f) => f.sessionId === "dur-x"));
  assert.equal(s.frames.find((f) => f.type === "result").sessionId, "dur-x");
  assert.ok(existsSync(s.session.sessionFile));
});

test("lets-code's 'Enable the factory's experts?' is answered No, with an error frame (R-C2)", async (t) => {
  const s = await setup(t, { clients: 1 });
  await s.session.run("EXPERTS");
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  const r = s.log().find((c) => c.type === "extension_ui_response");
  assert.equal(r.confirmed, false);
  assert.equal(FACTORY_EXPERTS_ERROR, "factory experts must be enabled by the operator");
  assert.ok(s.frames.some((f) => f.type === "error" && f.message === FACTORY_EXPERTS_ERROR));
  assert.equal(s.frames.filter((f) => f.type === "permission_request").length, 0, "never offered to the glasses");
  assert.equal(s.dialogs.length, 0);
  assert.equal(s.session.respondPermission("allow"), false, "nothing to answer");
});

test("a plain confirm swept after 10 minutes unwatched gets confirmed:false, not a select value", async (t) => {
  const s = await setup(t, { clients: 0 });
  await s.session.run("CONFIRM");
  await until(() => s.frames.some((f) => f.type === "permission_request"));
  assert.equal(s.session.sweepDialogs(s.t0 + 600_000), 1);
  await until(() => s.log().some((c) => c.type === "extension_ui_response"));
  const r = s.log().find((c) => c.type === "extension_ui_response");
  assert.equal(r.confirmed, false);
  assert.equal(r.value, undefined);
});
