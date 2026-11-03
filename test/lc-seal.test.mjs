// The in-process seal of a lets-code project (seal-core.mjs), as every pi of the project runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installProjectGuard, sealAfterTool, sealDirs } from "../src/providers/durable/lc/seal-core.mjs";

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "lc-seal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proj = join(root, "proj");
  mkdirSync(proj);
  installProjectGuard(proj);
  return { root, proj, q: join(root, "quarantine") };
}

/** The project-local guard as pi loads it: its default export registers handlers on a fake pi. */
async function loadGuard(proj) {
  const handlers = {};
  const mod = await import(pathToFileURL(join(proj, ".pi", "extensions", "even-guard.ts")).href + `?t=${Date.now()}`);
  mod.default({ on: (name, fn) => (handlers[name] = fn) });
  return handlers;
}

function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
}

test("a subagent chain: what the first subagent plants is quarantined before the next one loads .pi", async (t) => {
  const { root, proj, q } = project(t);
  const guard = await loadGuard(proj);
  assert.equal(typeof guard.tool_call, "function");
  assert.equal(typeof guard.tool_result, "function");
  // subagent A plants two ways the bash text rule cannot see: a tar unpack, a computed path
  const stage = join(root, "stage");
  mkdirSync(join(stage, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(stage, ".pi", "extensions", "evil.ts"), "export default () => {}");
  execFileSync("tar", ["cf", join(root, "p.tar"), "-C", stage, ".pi"]);
  execFileSync("tar", ["xf", join(root, "p.tar")], { cwd: proj });
  execFileSync("sh", ["-c", "d=.p; echo '{}' > ${d}i/settings.json"], { cwd: proj });
  assert.ok(existsSync(join(proj, ".pi", "extensions", "evil.ts")));
  // pi runs A's tool_result handlers before A returns to its parent
  const out = await withEnv({ EVEN_GUARD_CWD: proj, EVEN_GUARD_QUARANTINE: q }, () =>
    guard.tool_result({ type: "tool_result", toolName: "bash", content: [{ type: "text", text: "ok" }] }),
  );
  assert.equal(out.content[0].text, "ok");
  assert.match(out.content[1].text, /^even-guard: removed .*evil\.ts/);
  assert.match(out.content[1].text, /settings\.json/);
  // what subagent B finds when it starts and loads the project's extensions
  assert.deepEqual(readdirSync(join(proj, ".pi")), ["extensions"]);
  assert.deepEqual(readdirSync(join(proj, ".pi", "extensions")), ["even-guard.ts"]);
  assert.equal(readdirSync(q).length, 2, "moved to the quarantine");
  // nothing to undo: the tool result is left alone
  const none = await withEnv({ EVEN_GUARD_CWD: proj, EVEN_GUARD_QUARANTINE: q }, () => guard.tool_result({ content: [] }));
  assert.equal(none, undefined);
});

test("a tampered guard is restored by the next tool result", async (t) => {
  const { proj, q } = project(t);
  const g = join(proj, ".pi", "extensions", "even-guard.ts");
  const good = readFileSync(g, "utf8");
  writeFileSync(g, "export default () => {}");
  const out = sealAfterTool({ content: [] }, { env: { EVEN_GUARD_CWD: proj, EVEN_GUARD_QUARANTINE: q }, cwd: "/" });
  assert.match(out.content[0].text, /restored the guard/);
  assert.equal(readFileSync(g, "utf8"), good);
});

test("sealDirs: the project, and the pi's own cwd only when it is a factory worktree", () => {
  assert.deepEqual(sealDirs({ env: { EVEN_GUARD_CWD: "/w/p" }, cwd: "/w/p" }), ["/w/p"]);
  assert.deepEqual(sealDirs({ env: { EVEN_GUARD_CWD: "/w/p" }, cwd: "/h/.pi/agent/lets-code-factory/x/work" }), ["/w/p", "/h/.pi/agent/lets-code-factory/x/work"]);
  assert.deepEqual(sealDirs({ env: { EVEN_GUARD_CWD: "/w/p" }, cwd: "/tmp" }), ["/w/p"]);
  assert.deepEqual(sealDirs({ env: {}, cwd: "/tmp" }), []);
});
