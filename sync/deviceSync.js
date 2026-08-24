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
/**
 * Does a decoded remote message actually look like this project's
 * {partIndex, stepIndex, state, mode?} snapshot shape? The pacemaker's own
 * pre-existing dashboard<->learner pairing reads the identical ?relay=/?code=
 * URL params this module does (see CLAUDE.md's "pacer bridge mechanics"
 * notes) - if a user ever points both systems at the same relay room, each
 * would otherwise receive the other's differently-shaped messages over the
 * SAME room and could corrupt its own state trying to merge them. Not
 * enforced by createDeviceSync itself (which stays a generic opaque-JSON
 * transport) - every onRemoteSnapshot in this project calls this first.
 */
export function isValidSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot.partIndex === 'number'
    && typeof snapshot.stepIndex === 'number'
    && snapshot.state !== null && typeof snapshot.state === 'object';
}

/**
 * Same purpose as isValidSnapshot() above, for the OTHER snapshot shape this
 * project's sync bus can now carry: {currentStageId, state, mode?, engine:'v2'}
 * from a v2 (stage-graph, engine/stageRunner.js) scenario driven from the
 * Facilitator Console, instead of v1's {partIndex, stepIndex, state, mode?}.
 * Deliberately a SEPARATE function rather than a modified isValidSnapshot():
 * a receiver needs to know WHICH shape arrived (they apply completely
 * differently - v1 mutates a local partIndex/stepIndex-based runner, v2 only
 * ever touches the physiology `state` for display) not just "is this valid
 * for me." A v1-only receiver that never calls this will simply and safely
 * ignore a v2 broadcast (isValidSnapshot() correctly returns false for a
 * {currentStageId,...} payload, since it has no partIndex/stepIndex) -
 * that's the correct default for any device not yet updated to understand
 * v2, not a bug to work around.
 */
export function isValidGraphSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot.currentStageId === 'string' && snapshot.currentStageId.length > 0
    && snapshot.state !== null && typeof snapshot.state === 'object';
}

/**
 * Phase 8 (Patient Assessments Monitor) - a THIRD, structurally distinct
 * shape this bus can carry: {tiles, requests} from assessments/index.html.
 * Deliberately reuses createDeviceSync() (same channel, same relay, same
 * winId/self-echo guard) rather than a parallel sync module, per this
 * project's standing "do not introduce a second transport" rule - but this
 * payload has NOTHING in common structurally with either physiology
 * snapshot shape (no partIndex/stepIndex/currentStageId/state), so a
 * physiology-only receiver's isValidSnapshot()/isValidGraphSnapshot() both
 * correctly return false for it automatically, the same "mutually exclusive
 * shapes on one channel" pattern already proven for v1/v2. The Assessments
 * Monitor's own onRemoteSnapshot, symmetrically, must call THIS function
 * first and ignore anything that isn't - a v1/v2 physiology broadcast from
 * the console/IntelliVue/HemoSphere/pacemaker will otherwise also arrive on
 * this exact channel, since it's the same bus.
 */
export function isValidAssessmentMessage(snapshot) {
  return !!snapshot
    && Array.isArray(snapshot.tiles)
    && snapshot.requests !== null && typeof snapshot.requests === 'object' && !Array.isArray(snapshot.requests);
}

/**
 * Phase 9 (Cross-device real-time sessions) - a FOURTH structurally distinct
 * shape this bus can carry: {s, P, conn, N} from the pacemaker's own
 * dashboard<->learner control-panel pairing (devices/pacemaker/5392-pacemaker-simulator.html's
 * `snapState()`), now migrated onto this shared transport instead of its own
 * hand-rolled BroadcastChannel('sim5392')/relay implementation - closing the
 * "two incompatible sync systems coexist in the same relay room" gap the
 * audit named (§2, §12): previously, a console-generated pacemaker learner
 * link put BOTH systems in the same relay room, and only ONE direction of
 * that collision was actually guarded (isValidSnapshot() correctly rejects a
 * {s,P,conn,N} payload) - the OTHER direction (the pacemaker's own
 * unguarded `if(o.s)...if(o.P)...` applyRemote silently no-op'ing on a v1/v2
 * physiology snapshot) worked, in the code's own prior comment, "by luck,
 * not a guarantee." This function is the real fix: the pacemaker's control-
 * panel sync now checks this explicitly before applying anything, same
 * pattern as every other shape on this bus.
 */
export function isValidPacerControlMessage(snapshot) {
  return !!snapshot
    && snapshot.s !== null && typeof snapshot.s === 'object' && !Array.isArray(snapshot.s)
    && snapshot.P !== null && typeof snapshot.P === 'object' && !Array.isArray(snapshot.P)
    && snapshot.N !== null && typeof snapshot.N === 'object' && !Array.isArray(snapshot.N);
}

/**
 * Phase 9's pause gate: while paused, NOTHING broadcasts on ANY transport
 * (BroadcastChannel, relay, cloud) - this is the actual mechanism behind
 * "pause freezes all three device categories" and the "hidden resume
 * snapshot" acceptance criterion. It is deliberately simpler than a
 * per-transport gate (only silencing the cloud arm, say): freezing every
 * transport uniformly means a facilitator's local rehearsal (clicking
 * Next/overrides while paused, to stage what comes next) never leaks to
 * ANY connected peer, same-machine or cross-device, until resume - not just
 * to remote learners. See sync/cloudSession.js's preparePending()/
 * publishPending() for the durable (Postgres) half of this flow, which is
 * what a REFRESHING/reconnecting device hydrates from while paused.
 */
export function shouldBroadcast({ paused, nextStr, lastStr }) {
  if (paused) return false;
  return shouldPush(nextStr, lastStr);
}

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
 * @param {string} [relayUrl] - wss:// endpoint for cross-device pairing (legacy WS relay, unchanged).
 * @param {string} [relayCode] - session code; pass none and call setRelay() later to generate one.
 * @param {object} [cloudClient] - a Supabase client (sync/cloudSession.js's `supabase` export), for
 *   Phase 9's opt-in Cloud Session transport. Omit entirely to leave this device on the legacy
 *   BroadcastChannel/relay-only path, unchanged from every phase before this one.
 * @param {string} [cloudChannelName] - Realtime Broadcast channel name (sync/cloudSession.js's
 *   sessionChannelName()); pass none and call setCloud() later once a session code exists.
 */
export function createDeviceSync({ getSnapshot, onRemoteSnapshot, relayUrl, relayCode, cloudClient, cloudChannelName }) {
  const winId = Math.random().toString(36).slice(2);
  let lastSyncStr = null;
  let lastRecvAt = 0;

  const relay = { url: relayUrl || '', code: relayCode || '', ws: null, peers: 0, want: false, backoff: BACKOFF_START_MS };
  // Cloud (Phase 9) is deliberately a much lighter object than `relay` - it
  // has no reconnect/backoff state of its own because supabase-js's Realtime
  // client already owns reconnection internally; `channel`/`subscribed` are
  // the only two things sendRaw() and setCloud() need to touch.
  const cloud = { client: cloudClient || null, channelName: cloudChannelName || '', channel: null, subscribed: false };

  function sendRaw(str) {
    lastSyncStr = str;
    const msg = { win: winId, data: str };
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(msg)); } catch (e) { /* private browsing etc */ }
    if (bc) { try { bc.postMessage(msg); } catch (e) {} }
    if (relay.ws && relay.ws.readyState === 1) {
      try { relay.ws.send(JSON.stringify({ type: 'state', code: relay.code, win: winId, data: str })); } catch (e) {}
    }
    if (cloud.channel && cloud.subscribed) {
      try { cloud.channel.send({ type: 'broadcast', event: 'state', payload: msg }); } catch (e) {}
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

  let paused = false;
  function pushSync() {
    const str = JSON.stringify(getSnapshot());
    if (!shouldBroadcast({ paused, nextStr: str, lastStr: lastSyncStr })) return;
    sendRaw(str);
  }
  function sendHeartbeat() { if (paused) return; sendRaw(JSON.stringify(getSnapshot())); } // unconditional-when-unpaused, so a newly-opened peer catches up even with no state change
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

  /**
   * Open (or reopen) the Supabase Realtime Broadcast channel for the cloud
   * transport. `{config:{broadcast:{self:false}}}` mirrors the self-echo
   * guard the BroadcastChannel/relay arms already get for free from
   * shouldApplyRemote()'s winId check - Realtime's own `self:false` option
   * does the equivalent at the subscription level, so applyRemote() never
   * even sees this window's own broadcasts back.
   */
  function connectCloud() {
    if (!cloud.client || !cloud.channelName) return;
    if (cloud.channel) { try { cloud.client.removeChannel(cloud.channel); } catch (e) {} }
    cloud.subscribed = false;
    const ch = cloud.client.channel(cloud.channelName, { config: { broadcast: { self: false, ack: false } } });
    ch.on('broadcast', { event: 'state' }, ({ payload }) => applyRemote(payload));
    ch.subscribe((status) => {
      cloud.subscribed = (status === 'SUBSCRIBED');
      if (cloud.subscribed) sendRaw(JSON.stringify(getSnapshot())); // catch a newly-joined peer up immediately, don't wait for the next interval tick
    });
    cloud.channel = ch;
  }
  if (cloud.client && cloud.channelName) connectCloud();

  return {
    relay,
    cloud,
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
    /** Set/replace the cloud (Supabase Realtime) channel and (re)connect - the Phase 9 equivalent of setRelay() above, same late-binding rationale (a session code may not exist yet at createDeviceSync() call time). */
    setCloud(client, channelName) {
      cloud.client = client;
      cloud.channelName = channelName;
      connectCloud();
    },
    isLinked: () => Date.now() - lastRecvAt < STALE_MS,
    isCloudLinked: () => cloud.subscribed,
    peerCount: () => relay.peers,
    /** Freeze all outbound broadcasting (every transport) - see shouldBroadcast()'s doc comment above for why this is "all three device categories", not just cloud. */
    pause() { paused = true; },
    /** Resume outbound broadcasting. The next interval tick immediately sends current getSnapshot() - callers doing a Publish flow should write their durable pending_data->data copy BEFORE calling this, so the first live broadcast after resume already reflects the published state. */
    resume() { paused = false; },
    isPaused: () => paused,
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
