// Read-only "is a session active on this machine right now" detector for
// non-participating admin/facilitator pages (the homepage today; the
// Scenario Builder and Assessments Monitor stubs may want the same signal
// later). Deliberately NOT sync/deviceSync.js's createDeviceSync(): that
// function is a full read+write peer that also PUSHES a heartbeat onto the
// shared bus every PUSH_MS/HEARTBEAT_MS tick. If a non-scenario-owning page
// called it, its own heartbeat would get treated by every real device as a
// legitimate {partIndex, stepIndex, state} snapshot (isValidSnapshot() only
// checks shape, not origin) and could silently stomp whatever scenario is
// actually running. This module only ever listens - same channel/key
// constants as sync/deviceSync.js (never a second transport), zero writes.
//
// What this can honestly tell you: whether ANY device on THIS sync bus
// (BroadcastChannel + localStorage mirror, i.e. same machine) has sent
// something recently. It cannot see a peer connected only through the
// cross-device relay - that's a genuinely different question ("is there an
// active session anywhere") that needs a real presence channel, arriving
// with the Supabase-backed realtime layer in Phase 9. Label it honestly in
// the UI as same-machine status until then.

import { CHANNEL_NAME, SYNC_KEY } from '../sync/deviceSync.js';

const STALE_MS = 2200; // matches sync/deviceSync.js's own STALE_MS - same definition of "still live"

/** Pure: was the bus heard from recently enough to call it "active"? Exported for tests. */
export function isRecentlyActive(lastSeenAtMs, nowMs, staleMs = STALE_MS) {
  if (lastSeenAtMs == null) return false;
  return nowMs - lastSeenAtMs < staleMs;
}

/**
 * Start listening. Returns { getLastSeenAt, isActive, stop }. Call stop()
 * to tear down listeners (e.g. on page navigation away, though a full page
 * unload cleans these up anyway).
 */
export function watchSameMachinePresence() {
  let lastSeenAt = null;
  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL_NAME); } catch (e) { /* older Safari - storage listener below still covers it */ }
  const onBcMessage = () => { lastSeenAt = Date.now(); };
  if (bc) bc.onmessage = onBcMessage;

  const onStorage = (e) => { if (e.key === SYNC_KEY && e.newValue) lastSeenAt = Date.now(); };
  window.addEventListener('storage', onStorage);

  return {
    getLastSeenAt: () => lastSeenAt,
    isActive: (nowMs = Date.now()) => isRecentlyActive(lastSeenAt, nowMs),
    stop: () => {
      if (bc) { try { bc.close(); } catch (e) {} }
      window.removeEventListener('storage', onStorage);
    },
  };
}
