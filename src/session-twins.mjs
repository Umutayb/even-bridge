// RC twins: the claude-remote fork runs the real `claude --remote-control` CLI, so
// each live RC session ALSO exists as a local Claude Code transcript under
// ~/.claude/projects/. The same conversation would be listed twice (the cse_… RC
// session and a local claude session). The RC entry is kept (the upstream only
// knows its cse_ id) and the local duplicate is dropped; the RC row borrows the
// local row's title and cwd.
//
// One function for every list that shows both kinds: the phone's GET /api/sessions
// (ext-router.mjs) and the overseer's session inventory (overseer/host.mjs).
import { findBridgeSessionId } from "./rc-transcripts.mjs";

/**
 * @param {object[]} local local Claude Code rows ({id, cwd, title?})
 * @param {object[]} rcList RC rows ({id, cwd?, title?}); twins get the local title and cwd (mutated)
 * @param {object} [o]
 * @param {string} [o.base] the CC projects dir (findBridgeSessionId's default when unset)
 * @param {(cwd: string, localId: string) => string|null} [o.twinOf] the RC id a local transcript belongs to
 * @returns {object[]} `local` without the twins (the same array when nothing is dropped)
 */
export function dropRcTwins(local, rcList, { base, twinOf } = {}) {
  if (!rcList?.length || !local?.length) return local;
  const find = twinOf ?? ((cwd, id) => findBridgeSessionId(cwd, id, base));
  const rcIds = new Set(rcList.map((s) => s.id));
  const rcByTwin = new Map(); // local session id -> rc id
  const dropLocal = new Set();
  for (const s of local) {
    let rcId = null;
    try {
      rcId = find(s.cwd, s.id);
    } catch {
      /* ignore */
    }
    if (rcId && rcIds.has(rcId)) {
      dropLocal.add(s.id);
      rcByTwin.set(s.id, rcId);
    }
  }
  if (dropLocal.size === 0) return local;
  for (const rc of rcList) {
    const twin = local.find((l) => rcByTwin.get(l.id) === rc.id);
    if (twin) {
      rc.title = twin.title || rc.title;
      rc.cwd = twin.cwd || rc.cwd;
    }
  }
  return local.filter((s) => !dropLocal.has(s.id));
}
