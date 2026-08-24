// Phase 9 (Cross-device real-time sessions) - the PURE half of cloudSession.js,
// split into its own zero-dependency module specifically so it's unit
// testable under plain `node --test` without touching the network. (The rest
// of cloudSession.js imports supabase/client.js, which imports the real
// Supabase SDK over an https:// ESM specifier - Node's test runner can't
// resolve that import at all, so nothing in a file that imports it can be
// unit tested. Same reasoning as why supabase/client.js itself has never had
// a *.test.js file - see CLAUDE.md's Supabase section.)
//
// cloudSession.js re-exports everything here, so callers only ever need to
// import from cloudSession.js - this split is an internal testability detail,
// not a second public API surface.

/**
 * Which write policy applies to a given (role, channel) pair - a CLIENT-SIDE
 * mirror of supabase/schema-sessions.sql's RLS policies, used only for local
 * UI gating (disabling a control before the network round-trip, giving
 * instant feedback) - NOT the actual security boundary, which is RLS itself
 * (enforced server-side regardless of what this function says). Keep this in
 * sync with schema-sessions.sql's "facilitators can write physiology and
 * pacer snapshots" policy if that policy ever changes.
 */
export function canWriteChannel(role, channel) {
  if (channel === 'assessments') return role === 'facilitator' || role === 'learner';
  if (channel === 'physiology' || channel === 'pacer_control') return role === 'facilitator';
  return false;
}

/** Realtime Broadcast channel name for a given session code + data channel. Must match on both ends to pair. */
export function sessionChannelName(code, channel) {
  return `session:${code}:${channel}`;
}

/**
 * Parse the URL search params a joining device reads on load - `?session=`
 * (the 6-char code; presence of this param is what turns on the Cloud
 * Session path at all), `?role=` (facilitator|learner, defaults to learner
 * since every existing `?role=learner` pop-out link already uses this exact
 * param name - deliberately reusing it rather than inventing a second one),
 * `?device=` (optional device_label for the facilitator's presence/roster
 * view - 'console'|'intellivue'|'hemosphere'|'pacemaker'|'assessments').
 */
export function parseSessionParams(searchParams) {
  const code = (searchParams.get('session') || '').trim().toUpperCase();
  const roleParam = searchParams.get('role');
  const role = roleParam === 'facilitator' ? 'facilitator' : 'learner'; // matches this project's existing default-is-learner convention
  const device = searchParams.get('device') || null;
  return { code: code || null, role, device };
}

/**
 * Build a joinable link for a given base page URL + session code. Mirrors
 * the shape of every existing `?role=learner` link in this repo, with
 * `session=` added and `relay=`/`code=` (the legacy WS-relay params)
 * deliberately absent - a Cloud Session link and a legacy relay link are two
 * different pairing mechanisms and never need to carry both.
 */
export function buildSessionLink(baseUrl, code, { role = 'learner', device = null } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('session', code);
  url.searchParams.set('role', role);
  if (device) url.searchParams.set('device', device);
  return url.toString();
}

/**
 * Decide whether a freshly-fetched durable snapshot (from session_snapshots)
 * is actually newer/more-authoritative than what's already applied locally,
 * so hydrateSnapshot() in cloudSession.js doesn't stomp a value the live
 * Broadcast arm already delivered more recently. Pure comparison, no clock
 * reads inside - caller supplies both timestamps.
 */
export function shouldHydrate({ rowUpdatedAtMs, lastAppliedAtMs }) {
  if (!Number.isFinite(rowUpdatedAtMs)) return false;
  if (!Number.isFinite(lastAppliedAtMs)) return true; // never applied anything yet - definitely hydrate
  return rowUpdatedAtMs > lastAppliedAtMs;
}
