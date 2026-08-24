// Phase 9 (Cross-device real-time sessions) - Supabase-backed session
// management: creating/joining a session, role assignment, durable
// hydration-on-reconnect, and the Pause -> "prepare next state" -> Publish
// flow (the audit's "hidden resume snapshot" acceptance criterion).
//
// Deliberately a SEPARATE module from sync/deviceSync.js, not folded into
// it: deviceSync.js owns the live, ephemeral, every-140ms transport (same
// job the old WS relay had - see createDeviceSync's new cloud* params
// below); this module owns the slower, durable, Postgres-backed session
// lifecycle (create/join/roles/pause/publish/hydrate). A device wires BOTH
// together at boot - see facilitator/console.html's "Cloud Session" panel
// for the reference integration.
//
// FEATURE-FLAGGED, DUAL-TRANSPORT (per the user's explicit Phase 9 choice):
// this is a NEW, additive, opt-in path. The existing BroadcastChannel
// (same-machine, always-on) and WebSocket relay (cross-device, opt-in,
// unchanged) both keep working exactly as before - nothing here is wired in
// unless a device explicitly starts or joins a Cloud Session. This lets the
// relay stay the fallback/switchable path the audit's own risk note asked
// for, until this path is proven against real hardware over time.
//
// The pure logic (no network, unit tested) lives in cloudSessionLogic.js and
// is re-exported here so callers only ever need this one import.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../supabase/client.js';
import { genCode } from './deviceSync.js'; // no circular import - deviceSync.js never imports this module

export { canWriteChannel, sessionChannelName, parseSessionParams, buildSessionLink, shouldHydrate } from './cloudSessionLogic.js';

/**
 * A REAL bug found during Phase 9 live verification, not a theoretical one:
 * this module originally reused the app-wide `supabase` client from
 * supabase/client.js, which persists its auth session to localStorage -
 * shared across every tab of the SAME browser. That's exactly right for the
 * Scenario Builder's author sign-in (an author should stay signed in across
 * tabs/reloads), but WRONG for a Cloud Session participant identity: this
 * project's single most common usage pattern is one facilitator opening
 * several device pages as separate tabs/windows of the SAME browser
 * ("same-machine sync already works, zero setup" - see every device page's
 * own copy). With a shared localStorage identity, the console tab (joining
 * as facilitator) and an IntelliVue tab opened right after it (joining as
 * learner) are literally the SAME anon user_id - the second join's `upsert`
 * silently overwrote the first's role, downgrading the facilitator to a
 * learner and breaking every facilitator-only write (Pause/Prepare/Publish,
 * physiology updates) with a genuine RLS 42501 error. Caught by testing the
 * actual Prepare-Next-State flow live, exactly the kind of gap unit tests
 * alone can't catch (no unit test exercises two real browser tabs).
 *
 * Fix: Cloud Session's anonymous identity gets its OWN client, backed by
 * sessionStorage instead of localStorage - sessionStorage is NOT shared
 * across tabs (only within one tab and same-tab navigations), so each
 * window genuinely gets its own participant identity, matching this
 * project's own device/window model. The main `supabase` client (Builder
 * auth, published-scenario reads) is completely untouched.
 */
const sessionStorageAdapter = {
  getItem: (key) => { try { return window.sessionStorage.getItem(key); } catch (e) { return null; } },
  setItem: (key, value) => { try { window.sessionStorage.setItem(key, value); } catch (e) {} },
  removeItem: (key) => { try { window.sessionStorage.removeItem(key); } catch (e) {} },
};
export const cloudClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { storage: sessionStorageAdapter, persistSession: true, autoRefreshToken: true, storageKey: 'ct-surgery-sim-cloud-session-auth' },
});

// ---------------------------------------------------------------------------
// Supabase-calling functions - integration-verified live in-browser (same
// convention as supabase/client.js and the Phase 3 auth/publish flows), not
// unit tested here: they need a real anon session + real RLS-governed
// tables, which node --test has no way to stand up.
// ---------------------------------------------------------------------------

/** Sign in anonymously if not already signed in. A no-op (returns the existing session) if one exists - safe to call on every page load. */
export async function ensureAnonAuth() {
  const { data: { session } } = await cloudClient.auth.getSession();
  if (session) return session;
  const { data, error } = await cloudClient.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

/** Create a new session row + insert the creator as its facilitator. Returns the session row {id, code, ...}. */
export async function createSession({ engineMode = 'v1', scenarioRef = null, deviceLabel = 'console' } = {}) {
  const auth = await ensureAnonAuth();
  const code = genCode();
  const { data: session, error } = await cloudClient
    .from('sessions')
    .insert({ code, engine_mode: engineMode, scenario_ref: scenarioRef })
    .select()
    .single();
  if (error) throw error;
  const { error: joinError } = await cloudClient
    .from('session_participants')
    .insert({ session_id: session.id, user_id: auth.user.id, role: 'facilitator', device_label: deviceLabel });
  if (joinError) throw joinError;
  await logEvent(session.id, 'join', { role: 'facilitator', device_label: deviceLabel });
  return session;
}

/**
 * Look up a session by its join code. Returns null if not found (a
 * stale/typo'd code) or already ended.
 *
 * Real bug found live-testing a genuinely FRESH tab (one that had never
 * authenticated on this browser's cloudClient before): this used to run
 * before any caller had a chance to call ensureAnonAuth(), so the very
 * first request of a brand-new join flow went out with no identity at all -
 * `sessions`' own RLS policy (`auth.uid() is not null`) correctly rejected
 * it with a 403. Ensuring auth HERE, not just inside joinSession() below,
 * fixes the actual call order every join flow uses
 * (findSessionByCode -> joinSession).
 */
export async function findSessionByCode(code) {
  await ensureAnonAuth();
  const { data, error } = await cloudClient.from('sessions').select().eq('code', code).is('ended_at', null).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Join an existing session (by row, from findSessionByCode) with a role +
 * optional device label.
 *
 * Deliberately explicit select-then-insert-or-update, NOT `.upsert()`. Real
 * bug found live-testing a genuinely fresh identity's first-ever join to a
 * session: `.upsert()` (INSERT ... ON CONFLICT DO UPDATE) failed with a
 * 42501 RLS violation even though an identical plain `.insert()` succeeded
 * moments earlier. Root cause is a documented but non-obvious Postgres RLS
 * behavior: for ON CONFLICT DO UPDATE, Postgres requires the current role
 * to satisfy BOTH the INSERT policy's WITH CHECK and a passing UPDATE
 * policy - even on the pure-insert path where no conflict actually occurs.
 * Splitting into an explicit branch sidesteps that interaction entirely and
 * is easier to reason about besides.
 *
 * This also naturally subsumes the "never downgrade an existing
 * facilitator" guard (protects against some browsers, e.g. Chrome's
 * "Duplicate Tab", copying sessionStorage into a new tab and letting a
 * facilitator's own duplicated tab re-join as a default-role learner) - no
 * separate pre-check needed, since `existing` is already fetched here.
 */
export async function joinSession(session, { role = 'learner', deviceLabel = null } = {}) {
  const auth = await ensureAnonAuth();
  const nowIso = new Date().toISOString();
  // For a brand-new identity, this correctly returns zero rows (not an
  // error) - the read policy requires already BEING a participant, which a
  // first-time joiner isn't yet, so RLS just filters the result to empty.
  const { data: existing, error: selErr } = await cloudClient
    .from('session_participants').select('role')
    .eq('session_id', session.id).eq('user_id', auth.user.id).maybeSingle();
  if (selErr) throw selErr;
  const finalRole = (existing && existing.role === 'facilitator') ? 'facilitator' : role;
  if (existing) {
    const { error } = await cloudClient.from('session_participants')
      .update({ role: finalRole, device_label: deviceLabel, last_seen_at: nowIso })
      .eq('session_id', session.id).eq('user_id', auth.user.id);
    if (error) throw error;
  } else {
    const { error } = await cloudClient.from('session_participants')
      .insert({ session_id: session.id, user_id: auth.user.id, role: finalRole, device_label: deviceLabel, last_seen_at: nowIso });
    // Real race found live-testing the pacemaker page specifically: it runs
    // TWO independent join flows on load (the physiology bridge joining for
    // its state.pacer overlay, and this device's own separate control-panel
    // pairing joining for its 'pacer_control' channel) - both using the
    // SAME identity, both racing this exact select-then-insert sequence.
    // Whichever loses the race hits a genuine unique-constraint conflict on
    // (session_id, user_id) - a 409, not a bug in either caller alone, just
    // two legitimate concurrent joins for the same participant. Retry as an
    // update instead of throwing: the row now definitely exists (that's
    // what conflicted), so this always resolves the race on the next try.
    if (error && (error.code === '23505' || error.code === '409')) {
      const { error: retryError } = await cloudClient.from('session_participants')
        .update({ role: finalRole, device_label: deviceLabel, last_seen_at: nowIso })
        .eq('session_id', session.id).eq('user_id', auth.user.id);
      if (retryError) throw retryError;
    } else if (error) {
      throw error;
    }
  }
  await logEvent(session.id, 'join', { role: finalRole, device_label: deviceLabel });
}

/** Refresh this participant's last_seen_at - call periodically for presence, matches the heartbeat cadence pattern already used elsewhere in this repo. */
export async function touchPresence(sessionId, userId) {
  await cloudClient.from('session_participants').update({ last_seen_at: new Date().toISOString() }).eq('session_id', sessionId).eq('user_id', userId);
}

/** Fetch the current roster for a session's presence/connection-status UI. */
export async function fetchRoster(sessionId) {
  const { data, error } = await cloudClient.from('session_participants').select().eq('session_id', sessionId);
  if (error) throw error;
  return data || [];
}

/** Durable read for full-state hydration on join/reconnect. Returns null if nothing's been written yet. */
export async function hydrateSnapshot(sessionId, channel) {
  const { data, error } = await cloudClient.from('session_snapshots').select().eq('session_id', sessionId).eq('channel', channel).maybeSingle();
  if (error) throw error;
  return data;
}

/** Durable write of the live `data` column (the slow, periodic path - NOT the 140ms live-tick path, which travels over Realtime Broadcast in deviceSync.js instead). */
export async function writeSnapshot(sessionId, channel, dataObj) {
  const { error } = await cloudClient.from('session_snapshots').upsert({ session_id: sessionId, channel, data: dataObj });
  if (error) throw error;
}

/** Facilitator prepares a next state while paused - invisible to learners until publishPending(). */
export async function preparePending(sessionId, channel, dataObj) {
  const { error } = await cloudClient.from('session_snapshots').upsert({ session_id: sessionId, channel, pending_data: dataObj });
  if (error) throw error;
}

/** Publish the staged pending_data into the visible `data` column, then clear the staging column. */
export async function publishPending(sessionId, channel) {
  const row = await hydrateSnapshot(sessionId, channel);
  if (!row || row.pending_data == null) return false;
  const { error } = await cloudClient.from('session_snapshots').update({ data: row.pending_data, pending_data: null }).eq('session_id', sessionId).eq('channel', channel);
  if (error) throw error;
  await logEvent(sessionId, 'publish', { channel });
  return true;
}

/** Facilitator pause/resume toggle. */
export async function setPaused(sessionId, paused) {
  const { error } = await cloudClient.from('sessions').update({ paused }).eq('id', sessionId);
  if (error) throw error;
  await logEvent(sessionId, paused ? 'pause' : 'resume', {});
}

/** Lightweight audit-trail insert - never a debrief/scoring feature, see schema-sessions.sql's own comment on session_events. */
export async function logEvent(sessionId, eventType, detail) {
  try {
    const { data: { session } } = await cloudClient.auth.getSession();
    await cloudClient.from('session_events').insert({ session_id: sessionId, user_id: session?.user?.id ?? null, event_type: eventType, detail });
  } catch (e) { /* best-effort - never block the actual sync/UI flow on an audit-log write failing */ }
}
