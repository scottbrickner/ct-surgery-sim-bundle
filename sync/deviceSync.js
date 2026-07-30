// Cross-window/cross-device sync for the shared physiology runner
// (engine/scenarioRunner.js). Mirrors the pacemaker sim's own proven pattern
// (devices/pacemaker/5392-pacemaker-simulator.html's SYNC_*/relay.* code)
// rather than inventing a new design, per CLAUDE.md's "do not introduce a
// second transport": BroadcastChannel + a localStorage mirror for same-machine
// multi-window (zero config), plus an opt-in WebSocket relay for real
// cross-device pairing, driven by the same interval-snapshot push + win-id
// self-echo guard + heartbeat + backoff-reconnect model.
//
// What gets synced is deliberately narrow: {partIndex, stepIndex, state} -
// NEVER activeRamp. activeRamp.startedAtMs is a performance.now() timestamp,
// which is meaningless across windows/devices (different clock origins, and
// on a different machine entirely over the relay). Instead, whichever device
// is actively driving a ramp keeps ticking it locally (as built in Phase 2)
// and the interval push broadcasts each already-interpolated `state`
// snapshot - so followers just display incoming numbers, never running their
// own ramp math. This sidesteps cross-clock correctness issues entirely.

export const CHANNEL_NAME = 'ct-surgery-sim';
export const SYNC_KEY = 'ct-surgery-sim_sync_v1';
export const PUSH_MS = 140;       // matches the pacemaker's SYNC_PUSH_MS
export const HEARTBEAT_MS = 600;  // so a newly-opened peer catches up even with no state change
export const STALE_MS = 2200;     // "link" status goes stale if nothing received in this long
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MULT = 1.6;
export const BACKOFF_MAX_MS = 10000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids ambiguous read-aloud codes

/** 6-character session code for relay pairing, e.g. "K3RTQ9". */
export function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** Should this snapshot actually be sent? (Dedupe unchanged state between heartbeats.) */
export function shouldPush(nextSnapshotStr, lastSentStr) {
  return nextSnapshotStr !== lastSentStr;
}

/**
 * Should an incoming message actually be applied? False for our own echo
 * (same winId - all three transports can loop a sender's own message back
 * to itself) or for data identical to what we last sent/received (avoids
 * redundant re-renders from the heartbeat).
 */
export function shouldApplyRemote(msg, { winId, lastSyncStr }) {
  if (!msg || typeof msg.data !== 'string') return false;
  if (msg.win === winId) return false;
  if (msg.data === lastSyncStr) return false;
  return true;
}

/**
 * Wire up live sync for one device instance. Call once at boot.
 *
 * @param {() => {partIndex:number, stepIndex:number, state:object}} getSnapshot
 *   returns the current slice of local state to publish, every push tick.
 * @param {(snapshot:{partIndex:number, stepIndex:number, state:object}) => void} onRemoteSnapshot
 *   called whenever a peer's snapshot should be applied locally.
 * @param {string} [relayUrl] - wss:// endpoint for cross-device pairing.
 * @param {string} [relayCode] - session code; pass none and call setRelay() later to generate one.
 */
export function createDeviceSync({ getSnapshot, onRemoteSnapshot, relayUrl, relayCode }) {
  const winId = Math.random().toString(36).slice(2);
  let lastSyncStr = null;
  let lastRecvAt = 0;

  const relay = { url: relayUrl || '', code: relayCode || '', ws: null, peers: 0, want: false, backoff: BACKOFF_START_MS };

  function sendRaw(str) {
    lastSyncStr = str;
    const msg = { win: winId, data: str };
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(msg)); } catch (e) { /* private browsing etc */ }
    if (bc) { try { bc.postMessage(msg); } catch (e) {} }
    if (relay.ws && relay.ws.readyState === 1) {
      try { relay.ws.send(JSON.stringify({ type: 'state', code: relay.code, win: winId, data: str })); } catch (e) {}
    }
  }

  function applyRemote(msg) {
    if (!shouldApplyRemote(msg, { winId, lastSyncStr })) return;
    lastSyncStr = msg.data;
    lastRecvAt = Date.now();
    let snapshot;
    try { snapshot = JSON.parse(msg.data); } catch (e) { return; }
    onRemoteSnapshot(snapshot);
  }

  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL_NAME); } catch (e) { /* older Safari etc - localStorage mirror still covers same-machine */ }
  if (bc) bc.onmessage = (ev) => applyRemote(ev.data);
  window.addEventListener('storage', (e) => {
    if (e.key === SYNC_KEY && e.newValue) { try { applyRemote(JSON.parse(e.newValue)); } catch (e2) {} }
  });

  function pushSync() {
    const str = JSON.stringify(getSnapshot());
    if (!shouldPush(str, lastSyncStr)) return;
    sendRaw(str);
  }
  function sendHeartbeat() { sendRaw(JSON.stringify(getSnapshot())); } // unconditional, so a newly-opened peer catches up even with no state change
  setInterval(pushSync, PUSH_MS);
  setInterval(sendHeartbeat, HEARTBEAT_MS);

  function connectRelay() {
    if (!relay.url || !relay.code) return;
    relay.want = true;
    let ws;
    try { ws = new WebSocket(relay.url); } catch (e) { return; }
    relay.ws = ws;
    ws.onopen = () => {
      relay.backoff = BACKOFF_START_MS;
      try { ws.send(JSON.stringify({ type: 'join', code: relay.code, win: winId })); } catch (e) {}
      sendRaw(JSON.stringify(getSnapshot())); // catch the new peer up immediately, don't wait for the next interval tick
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'state') applyRemote({ win: m.win, data: m.data });
      else if (m.type === 'peers') relay.peers = m.n;
    };
    ws.onclose = () => {
      relay.ws = null;
      if (relay.want) { setTimeout(connectRelay, relay.backoff); relay.backoff = Math.min(relay.backoff * BACKOFF_MULT, BACKOFF_MAX_MS); }
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  if (relay.url && relay.code) connectRelay();
  setInterval(() => { if (relay.ws && relay.ws.readyState === 1) { try { relay.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {} } }, 25000);

  return {
    relay,
    /** Set/replace the relay endpoint and (re)connect. Generates a session code if none is given. Returns the code in use. */
    setRelay(url, code) {
      relay.want = false;
      if (relay.ws) { try { relay.ws.close(); } catch (e) {} }
      relay.url = url;
      relay.code = code || genCode();
      relay.backoff = BACKOFF_START_MS;
      connectRelay();
      return relay.code;
    },
    isLinked: () => Date.now() - lastRecvAt < STALE_MS,
    peerCount: () => relay.peers,
    /**
     * Force an immediate push, bypassing the PUSH_MS interval. Real users
     * never need this (the interval runs fine on a normal foreground tab) -
     * it exists for automated testing in environments where background-tab
     * timer throttling is aggressive enough that waiting for the interval
     * isn't practical, same rationale as engine tickNow() in the device
     * files' Phase 2 debug hook.
     */
    pushNow: pushSync,
    /** Unconditional resend, bypassing the dedupe check - what the heartbeat interval does. Same testing rationale as pushNow. */
    heartbeatNow: sendHeartbeat,
  };
}
