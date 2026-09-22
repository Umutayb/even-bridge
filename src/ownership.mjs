// Session-ID ownership registry.
//
// The Even phone app drives a bridge like the official even-terminal: session
// entries from /api/sessions carry a `provider` field, but the app only knows
// "claude"/"codex" and filters its list to those. So extended providers
// (claude-remote, pi) present every session as provider "claude" on the wire,
// and per-session calls are routed by OWNERSHIP: which backend actually owns
// this session id. This module is that registry.
//
//   claim(sid, provider)  — a provider says "I own this id"
//   getOwner(sid)         — synchronous lookup (registry only)
//   probeOwners(sid)      — ask each prober (async) until one claims the id
//   forget(sid)           — drop a claim (upstream says the session is gone)

const owners = new Map(); // sid -> { provider, at }

export const EXTENDED_PROVIDERS = Object.freeze(["claude-remote", "pi"]);

export function isExtendedProvider(name) {
  return EXTENDED_PROVIDERS.includes(name);
}

export function claim(sessionId, provider) {
  if (!sessionId) return;
  owners.set(sessionId, { provider, at: Date.now() });
}

export function getOwner(sessionId) {
  const entry = sessionId ? owners.get(sessionId) : undefined;
  return entry?.provider ?? null;
}

export function forget(sessionId) {
  owners.delete(sessionId);
}

/**
 * Ask each prober in order whether it owns `sessionId`. The first one that
 * answers true claims the id and wins. Probers must be cheap (a file stat or
 * one upstream GET) — this runs on the request path.
 *
 * @param {string} sessionId
 * @param {{ probe(sessionId: string): Promise<boolean>, name: string }[]} probers
 * @returns {Promise<string|null>} the owning provider name, or null
 */
export async function probeOwners(sessionId, probers) {
  if (!sessionId) return null;
  const known = getOwner(sessionId);
  if (known) return known;
  for (const prober of probers ?? []) {
    try {
      if (await prober.probe(sessionId)) {
        claim(sessionId, prober.name);
        return prober.name;
      }
    } catch {
      // A prober that errors (upstream down) must not break routing.
    }
  }
  return null;
}

export function _ownersSize() {
  return owners.size;
}
