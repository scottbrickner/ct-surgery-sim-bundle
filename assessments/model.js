// Phase 8 (Patient Assessments Monitor) - pure data-model functions,
// factored out of index.html's inline script so the reveal-rule logic is
// testable via `node --test` rather than embedded untestably in a page,
// matching every other module in this project (engine/, scenarios/,
// sync/). Nothing here touches the DOM, the clock, or sync - callers pass
// `nowMs` explicitly, same convention as engine/scenarioRunner.js.
//
// DATA MODEL
//   tile: { id, category, label, revealRule, priority, findings: [string, ...] }
//     - revealRule: 'auto' (reveals immediately on request) | 'approve'
//       (goes to the facilitator's pending queue) | 'hidden' (not
//       requestable at all - facilitator content not yet unlocked for
//       this scenario, or a note never meant for the learner surface).
//     - priority: boolean - shown in the top priority row regardless of
//       category, facilitator-configurable per scenario and mid-session
//       (the acceptance criterion this exists for).
//     - findings: an array of plain strings, v1 text-only. Deliberately an
//       array of STRINGS, not a single blob of text, and deliberately not
//       `{text}` objects either yet - kept as the simplest shape that can
//       grow into `{text, audioUrl}` per finding later (per the brief's
//       "design the data model, not just the UI, so audio can be added
//       later without restructuring") without a breaking change to what's
//       already the atomic unit (one finding = one array entry).
//   request: { status: 'pending'|'revealed'|'denied', requestedAtMs, resolvedAtMs }
//     - Deliberately real wall-clock timestamps (Date.now()-style), not
//       state.minute - this is interaction/UI tracking (how long has the
//       facilitator taken to respond), not simulated physiology, so it
//       should reflect real elapsed time regardless of whether the
//       simulated case clock has been fast-forwarded.
//
// SCOPE NOTE: this tracking is deliberately IN-SESSION ONLY, driving this
// page's own live UI (the facilitator's pending queue, the learner's tile
// states) - never exported, never a debrief report. This project has an
// explicit resolved decision against any debrief/scoring screen (see
// CLAUDE.md's "Resolved decisions") - confirmed directly before building
// this phase that in-session-only tracking doesn't reopen that decision.

export const CATEGORIES = ['outputs', 'assessment', 'sounds', 'therapies', 'patient'];
export const REVEAL_RULES = ['auto', 'approve', 'hidden'];
export const DEFAULT_DELAY_THRESHOLD_MS = 60000; // a pending request waiting this long surfaces as "delayed" in the facilitator queue - a live operational cue, not a report metric

// Chart Review, direct user request: "should be able to add documentation
// and chart review sections here including MD notes, procedure notes,
// Labs/diagnostics, eMAR." Confirmed scope with the user: static,
// facilitator-authored, read-only-to-the-learner text per section - NOT a
// structured/interactive EHR mockup (no individual lab values with flags,
// no timestamped eMAR administration states, no orderable items). Matches
// this page's existing tile pattern (facilitator authors ahead of time,
// learner reads) rather than introducing a second content model.
// Deliberately plain strings, not richer objects - the same "simplest shape
// that can grow later without breaking" reasoning `findings` above uses.
export const CHART_SECTIONS = ['mdNotes', 'procedureNotes', 'labs', 'emar'];

export function createAssessmentState(scenarioId) {
  return { scenarioId: scenarioId || '', tiles: [], requests: {}, chart: emptyChart() };
}

function emptyChart() {
  return Object.fromEntries(CHART_SECTIONS.map((s) => [s, '']));
}

/** Facilitator sets one chart section's text. No-ops on an unknown section name (defensive, matches this file's other no-op-on-invalid-input convention) - never throws on a typo'd caller. */
export function updateChartSection(state, section, text) {
  if (!CHART_SECTIONS.includes(section)) return state;
  return { ...state, chart: { ...(state.chart || emptyChart()), [section]: text } };
}

function uniqueTileId(state, base) {
  const ids = new Set(state.tiles.map((t) => t.id));
  let id = base, n = 2;
  while (ids.has(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

/** Add a tile, auto-deduplicating its id if one like it already exists (same convention as scenarios/Builder's uniqueStageId). */
export function addTile(state, tile) {
  const id = uniqueTileId(state, tile.id || 'tile');
  return { ...state, tiles: [...state.tiles, { priority: false, findings: [], ...tile, id }] };
}

export function updateTile(state, tileId, patch) {
  return { ...state, tiles: state.tiles.map((t) => (t.id === tileId ? { ...t, ...patch } : t)) };
}

/** Removing a tile also drops any request history for it - nothing left to track once the tile itself no longer exists. */
export function removeTile(state, tileId) {
  const { [tileId]: _dropped, ...remainingRequests } = state.requests;
  return { ...state, tiles: state.tiles.filter((t) => t.id !== tileId), requests: remainingRequests };
}

/**
 * A learner taps a tile. 'hidden' tiles can never be requested (no-op,
 * matches a real device simply not offering an unavailable action). A
 * tile already pending or revealed also no-ops - a second tap while
 * waiting isn't a new request, and a revealed tile doesn't need
 * re-requesting. 'auto' resolves immediately (status: 'revealed',
 * resolvedAtMs === requestedAtMs); 'approve' goes to 'pending' for the
 * facilitator queue.
 */
export function requestTile(state, tileId, nowMs) {
  const tile = state.tiles.find((t) => t.id === tileId);
  if (!tile || tile.revealRule === 'hidden') return state;
  const existing = state.requests[tileId];
  if (existing && (existing.status === 'pending' || existing.status === 'revealed')) return state;
  const status = tile.revealRule === 'auto' ? 'revealed' : 'pending';
  return {
    ...state,
    requests: { ...state.requests, [tileId]: { status, requestedAtMs: nowMs, resolvedAtMs: status === 'revealed' ? nowMs : null } },
  };
}

/** Facilitator approves or denies a pending request. No-ops if the request isn't actually pending (already resolved, or never requested) - same defensive-no-op convention as requestTile. */
export function resolveRequest(state, tileId, outcome, nowMs) {
  const existing = state.requests[tileId];
  if (!existing || existing.status !== 'pending') return state;
  const status = outcome === 'approve' ? 'revealed' : 'denied';
  return { ...state, requests: { ...state.requests, [tileId]: { ...existing, status, resolvedAtMs: nowMs } } };
}

/** What should the learner surface show for this tile right now: 'hidden' | 'available' | 'pending' | 'revealed' | 'denied'. */
export function getTileStatus(state, tileId) {
  const tile = state.tiles.find((t) => t.id === tileId);
  if (!tile) return null;
  if (tile.revealRule === 'hidden') return 'hidden';
  return state.requests[tileId]?.status || 'available';
}

/** The facilitator's live approval queue - every currently-pending request, oldest first, flagged 'delayed' once it's been waiting past the threshold. Nothing here is persisted; recomputed fresh from `state.requests` on every render. */
export function getPendingRequests(state, nowMs, delayThresholdMs = DEFAULT_DELAY_THRESHOLD_MS) {
  return Object.entries(state.requests)
    .filter(([, r]) => r.status === 'pending')
    .map(([tileId, r]) => ({
      tileId,
      tile: state.tiles.find((t) => t.id === tileId),
      requestedAtMs: r.requestedAtMs,
      waitingMs: nowMs - r.requestedAtMs,
      delayed: nowMs - r.requestedAtMs >= delayThresholdMs,
    }))
    .sort((a, b) => a.requestedAtMs - b.requestedAtMs);
}

/**
 * Live counts for the facilitator's own view only - revealed/pending/
 * denied/missed ('missed' = configured, requestable, but never requested
 * at all). NOT a debrief artifact - nothing here is exported, timestamped
 * for a report, or shown to the learner; it exists purely to help a
 * facilitator see at a glance what's been covered during the session.
 */
export function getSessionSummary(state) {
  const requestable = state.tiles.filter((t) => t.revealRule !== 'hidden');
  const statuses = requestable.map((t) => getTileStatus(state, t.id));
  return {
    total: requestable.length,
    revealed: statuses.filter((s) => s === 'revealed').length,
    pending: statuses.filter((s) => s === 'pending').length,
    denied: statuses.filter((s) => s === 'denied').length,
    missed: statuses.filter((s) => s === 'available').length,
  };
}
