// Drives a unified scenario (see scenarios/schema.md) through the shared
// physiology state in physiology.js. Pure functions throughout: every
// exported function takes a runner and returns a NEW runner rather than
// mutating its input, and none of them read the clock - callers pass
// `nowMs` explicitly, which keeps this testable with arbitrary timestamps
// and keeps a browser render loop free to pick its own clock source.
//
// Navigation model: each part has an `initialState` (the snapshot BEFORE
// any of that part's steps run) and a `steps` array. `stepIndex: -1` means
// "at the part's initialState, no steps applied yet". next()/prev() walk
// forward/back across step and part boundaries; crossing INTO a new part
// always lands on that part's initialState first (stepIndex -1) as its own
// stop, matching how the source case gives each part its own fresh
// "Start of scenario" snapshot rather than carrying the prior part's ending
// state forward (see BUILD_PROMPT.md §4 - Part 2 starts at a different BP
// than where Part 1 left off, hours having passed off-screen).

import { createState, applyInstant, rampState, getPath, setPathImmutable } from './physiology.js';

/** The fully-settled state at a given part/step position (ramps resolved to fraction 1). Internal - exported for tests. */
export function computeStateAt(scenario, partIndex, stepIndex) {
  const part = scenario.parts[partIndex];
  let state = createState(part.initialState);
  for (let i = 0; i <= stepIndex; i++) {
    const step = part.steps[i];
    if (step.type === 'ramp') state = rampState(state, step.target, 1);
    else if (step.type === 'instant' || step.type === 'event') state = applyInstant(state, step.set);
    // 'discussion' steps carry no state change.
  }
  return state;
}

export function createRunner(scenario) {
  return {
    scenario,
    partIndex: 0,
    stepIndex: -1,
    state: createState(scenario.parts[0].initialState),
    activeRamp: null, // { fromState, target, startedAtMs, durationMs }
    pendingAutoAdvance: null, // { fireAtMs, kind: 'scripted'|'custom', patch?, label? } - see checkAutoAdvance()
    overrides: {}, // { [path]: { releaseMode: 'hold'|'duration', releaseAt: ms|null, priorValue } } - see setOverrideWithRelease()
    releaseRamps: {}, // { [path]: { fromValue, toValue, startedAtMs, durationMs } } - in-flight gradual releases, see startGradualRelease()
    events: [],
  };
}

export function reset(runner) {
  return createRunner(runner.scenario);
}

export function jumpToPart(runner, partId) {
  const idx = runner.scenario.parts.findIndex((p) => p.id === partId);
  if (idx === -1) throw new Error(`Unknown part id: ${partId}`);
  return {
    ...runner,
    partIndex: idx,
    stepIndex: -1,
    state: createState(runner.scenario.parts[idx].initialState),
    activeRamp: null,
    pendingAutoAdvance: null,
    overrides: {},
    releaseRamps: {},
  };
}

export function next(runner, nowMs) {
  const { scenario, partIndex, stepIndex } = runner;
  const part = scenario.parts[partIndex];
  let newPartIndex = partIndex;
  let newStepIndex = stepIndex;
  if (stepIndex + 1 < part.steps.length) {
    newStepIndex = stepIndex + 1;
  } else if (partIndex + 1 < scenario.parts.length) {
    newPartIndex = partIndex + 1;
    newStepIndex = -1;
  } else {
    return runner; // already at the last step of the last part
  }

  let state;
  let activeRamp = null;
  let pendingAutoAdvance = null;
  let eventLabel;
  if (newStepIndex === -1) {
    state = createState(scenario.parts[newPartIndex].initialState);
    eventLabel = `${scenario.parts[newPartIndex].id}:start`;
  } else {
    const step = scenario.parts[newPartIndex].steps[newStepIndex];
    const priorState = computeStateAt(scenario, newPartIndex, newStepIndex - 1);
    if (step.type === 'ramp') {
      const durationMs = (step.durationMinutes || 0) * 60000;
      activeRamp = { fromState: priorState, target: step.target, startedAtMs: nowMs, durationMs };
      state = priorState; // tick() progresses it from here
      // Auto-advance is scheduled up front (not discovered reactively when the
      // ramp completes) since everything needed - start time, ramp duration,
      // grace period - is already known the instant the ramp begins. See
      // checkAutoAdvance() for why this fires next() rather than something
      // ramp-specific: an unaddressed decompensation advancing to whatever
      // scripted step follows (typically an `event` like arrest) is exactly
      // what a facilitator's own manual "Next" click would do at this point.
      if (typeof step.autoAdvanceAfterMinutes === 'number') {
        pendingAutoAdvance = { fireAtMs: nowMs + durationMs + step.autoAdvanceAfterMinutes * 60000, kind: 'scripted' };
      }
    } else if (step.type === 'discussion') {
      state = priorState;
    } else {
      state = applyInstant(priorState, step.set);
    }
    eventLabel = step.id;
  }

  return {
    ...runner,
    partIndex: newPartIndex,
    stepIndex: newStepIndex,
    state,
    activeRamp,
    pendingAutoAdvance,
    overrides: {},
    releaseRamps: {},
    events: [...runner.events, { at: eventLabel, nowMs }],
  };
}

export function prev(runner) {
  const { scenario, partIndex, stepIndex } = runner;
  let newPartIndex = partIndex;
  let newStepIndex = stepIndex;
  if (stepIndex > -1) {
    newStepIndex = stepIndex - 1;
  } else if (partIndex > 0) {
    newPartIndex = partIndex - 1;
    newStepIndex = scenario.parts[newPartIndex].steps.length - 1;
  } else {
    return runner; // already at the very start
  }
  return {
    ...runner,
    partIndex: newPartIndex,
    stepIndex: newStepIndex,
    state: computeStateAt(scenario, newPartIndex, newStepIndex),
    activeRamp: null,
    pendingAutoAdvance: null,
    overrides: {},
    releaseRamps: {},
  };
}

/**
 * Progress any in-flight ramp toward its target, AND any in-flight gradual
 * override releases (see tickReleaseRamps() below), given the current
 * wall-clock time. No-op for whichever of the two isn't active. Both share
 * one call so device tick loops don't need to remember to call two
 * functions - see facilitator/console.html's consoleTick() for the pattern.
 */
export function tick(runner, nowMs) {
  let result = runner;
  if (result.activeRamp) {
    const { fromState, target, startedAtMs, durationMs } = result.activeRamp;
    const fraction = durationMs <= 0 ? 1 : (nowMs - startedAtMs) / durationMs;
    const state = rampState(fromState, target, fraction);
    // pendingAutoAdvance (if any) is left untouched here - it was scheduled by
    // next() up front and fires via checkAutoAdvance(), independent of whether
    // the ramp itself has settled to activeRamp:null yet.
    result = { ...result, state, activeRamp: fraction >= 1 ? null : result.activeRamp };
  }
  result = tickReleaseRamps(result, nowMs);
  return result;
}

/**
 * Progress any in-flight ramp toward its target - see getRampProgress() for
 * a read-only view of the same thing, used to render a decompensation timer
 * without needing to derive fraction/remaining time by hand.
 */
export function getRampProgress(runner, nowMs) {
  if (!runner.activeRamp) return null;
  const { startedAtMs, durationMs } = runner.activeRamp;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const fraction = durationMs <= 0 ? 1 : Math.min(1, elapsedMs / durationMs);
  return { elapsedMs, durationMs, fraction, remainingMs: Math.max(0, durationMs - elapsedMs) };
}

/**
 * If a ramp step was authored with `autoAdvanceAfterMinutes`, calling this
 * every tick (alongside tick() itself) advances the scenario via next() once
 * that grace period elapses with no facilitator action - e.g. "if nobody
 * addresses the tamponade, it progresses to arrest on its own 3 minutes
 * after the ramp settles." A no-op if nothing is pending, or the fire time
 * hasn't arrived yet. The facilitator can always head this off first, either
 * by manually calling next()/prev()/jumpToPart() (which clear it as a side
 * effect of navigating) or by calling cancelAutoAdvance() to stay on the
 * current step indefinitely.
 *
 * Two independent sources can schedule a pendingAutoAdvance, distinguished by
 * `kind`: 'scripted' (set by next() when it enters a ramp step authored with
 * autoAdvanceAfterMinutes - fires by calling next() again, exactly like a
 * manual Next click) or 'custom' (set by startFacilitatorRamp() - fires by
 * applying an arbitrary facilitator-chosen patch via applyInstant, WITHOUT
 * touching partIndex/stepIndex, since a facilitator-timed decline isn't tied
 * to any scripted step and may be running mid-discussion in any part).
 */
export function checkAutoAdvance(runner, nowMs) {
  if (!runner.pendingAutoAdvance) return runner;
  if (nowMs < runner.pendingAutoAdvance.fireAtMs) return runner;
  if (runner.pendingAutoAdvance.kind === 'custom') {
    const { patch, nextStage, label } = runner.pendingAutoAdvance;
    // A configured next stage takes precedence over a flat outcome patch -
    // chains into ANOTHER startFacilitatorRamp() call (ramping from the
    // state this stage just settled at) instead of applying a one-shot
    // patch. Reuses startFacilitatorRamp() itself rather than a separate
    // "apply stage 2" code path, so a 3rd/4th chained stage works exactly
    // the same way, recursively, with no special-casing per depth - see
    // that function's own docblock for the full field shape a stage takes.
    if (nextStage) {
      return startFacilitatorRamp({ ...runner, pendingAutoAdvance: null }, nextStage, nowMs);
    }
    return {
      ...runner,
      state: patch ? applyInstant(runner.state, patch) : runner.state,
      activeRamp: null,
      pendingAutoAdvance: null,
      events: [...runner.events, { at: `custom-decline:${label || 'outcome'}`, nowMs }],
    };
  }
  return next(runner, nowMs);
}

/** Read-only view of a pending auto-advance, for rendering a countdown. Null if none is scheduled. Includes `label` (custom declines only - see startFacilitatorRamp) for the UI to show what's about to fire. */
export function getAutoAdvanceCountdown(runner, nowMs) {
  if (!runner.pendingAutoAdvance) return null;
  return { remainingMs: Math.max(0, runner.pendingAutoAdvance.fireAtMs - nowMs), label: runner.pendingAutoAdvance.label || null };
}

/**
 * Facilitator-driven counterpart to a scripted `ramp` step: ramp the CURRENT
 * state toward an arbitrary `target` over `durationMinutes`, usable at any
 * point in any part (mid-discussion, before a scripted ramp even exists in
 * that part, etc.) - independent of partIndex/stepIndex entirely, same
 * "independent of the scripted timeline" spirit as applyFacilitatorOverride().
 * If `autoAdvanceAfterMinutes` is given together with EITHER `outcomePatch`
 * or `nextStage`, schedules a 'custom' pendingAutoAdvance once the ramp
 * settles and that extra grace period elapses unaddressed:
 *   - `outcomePatch` (a partial state patch - e.g. an arrest-like flatline,
 *     a loss-of-capture flag) applies once, instantly, via applyInstant.
 *   - `nextStage` (this SAME {target, durationMinutes, autoAdvanceAfterMinutes,
 *     outcomePatch, nextStage, label} shape, one level deeper) chains into
 *     ANOTHER startFacilitatorRamp() call instead - a facilitator-authored
 *     multi-stage clinical change (e.g. subtle change -> decompensation ->
 *     arrest), recursing to whatever depth was actually configured. If both
 *     are given, `nextStage` wins (checkAutoAdvance() never applies a flat
 *     patch AND starts a further stage in the same fire).
 * Omit both for a decline-only ramp that just settles and waits (no auto-
 * fire) - same as a scripted ramp step without autoAdvanceAfterMinutes.
 * `label` is carried through to getAutoAdvanceCountdown() for the UI to
 * display (e.g. "cardiac arrest") - purely cosmetic, no engine meaning.
 */
export function startFacilitatorRamp(runner, { target, durationMinutes, autoAdvanceAfterMinutes, outcomePatch, nextStage, label }, nowMs) {
  const durationMs = (durationMinutes || 0) * 60000;
  const activeRamp = { fromState: runner.state, target, startedAtMs: nowMs, durationMs };
  let pendingAutoAdvance = null;
  if (typeof autoAdvanceAfterMinutes === 'number' && (outcomePatch || nextStage)) {
    pendingAutoAdvance = { fireAtMs: nowMs + durationMs + autoAdvanceAfterMinutes * 60000, kind: 'custom', patch: outcomePatch, label };
    // Only added when actually used - keeps the shape backward-compatible
    // with every pre-existing single-stage caller/test that checks this
    // object's exact fields (a present-but-undefined key is NOT the same
    // thing as an absent one under deepStrictEqual).
    if (nextStage) pendingAutoAdvance.nextStage = nextStage;
  }
  return {
    ...runner,
    activeRamp,
    pendingAutoAdvance,
    events: [...runner.events, { at: `custom-decline:${label || 'start'}`, nowMs }],
  };
}

/** Facilitator explicitly opts to stay on the current step - cancels a scheduled auto-advance without otherwise changing anything. */
export function cancelAutoAdvance(runner) {
  if (!runner.pendingAutoAdvance) return runner;
  return { ...runner, pendingAutoAdvance: null };
}

/**
 * Facilitator free-form nudge, independent of the scripted timeline. If a
 * ramp is currently in flight, its `fromState` is rebased to include the
 * override so the next tick() doesn't clobber it - the ramp keeps its
 * original schedule and target, just continues from the nudged values.
 *
 * This is the ORIGINAL, no-release-semantics override primitive - still the
 * right tool for discrete fields where "release mode" doesn't mean anything
 * (rhythm select, pacer capture toggle, arrest/sternotomy/ECMO flags). For a
 * numeric field that should support hold/duration/release behavior, use
 * setOverrideWithRelease() below instead.
 */
export function applyFacilitatorOverride(runner, patch) {
  const state = applyInstant(runner.state, patch);
  const activeRamp = runner.activeRamp
    ? { ...runner.activeRamp, fromState: applyInstant(runner.activeRamp.fromState, patch) }
    : null;
  return { ...runner, state, activeRamp };
}

/**
 * Explicitly jump the simulated case clock (state.minute) forward by
 * `minutesToAdvance` - Phase 5's "accelerated" time model. The existing
 * ramp/tick machinery above already covers the "realistic" side (a ramp
 * genuinely takes real wall-clock minutes to play out, per BUILD_PROMPT.md's
 * original "5-minute ramp means 5 real wall-clock minutes" decision, left
 * unchanged) - this is the new complementary action for skipping simulated
 * time forward without literally waiting, e.g. to demonstrate a slow-onset
 * medication's peak effect. Deliberately reuses applyFacilitatorOverride()
 * rather than duplicating its ramp-rebasing logic - advancing state.minute
 * is exactly a facilitator override on one path, nothing more. Medication
 * effects (engine/clinical/pharmacology.js) are computed as a pure function
 * of state.minute at read time, so nothing else needs recomputing here -
 * same "derived overlay, never mutates authored state" precedent as
 * physiology.js's getEffectiveHR/getEffectiveRhythm.
 */
export function advanceSimClock(runner, minutesToAdvance) {
  if (!(minutesToAdvance > 0)) return runner;
  return applyFacilitatorOverride(runner, { minute: runner.state.minute + minutesToAdvance });
}

/* =========================================================================
 * Override release model
 *
 * The brief asks for four release behaviors per override: hold indefinitely,
 * hold for a duration, gradually return control, immediately return control.
 * Rather than four flat, mutually-exclusive modes, these collapse cleanly
 * onto two orthogonal choices:
 *   - WHEN to auto-release: never ('hold'), or after a duration ('duration')
 *     - chosen up front, at setOverrideWithRelease() time.
 *   - HOW to release: now (releaseOverrideNow) or gradually
 *     (startGradualRelease) - callable at ANY time on an active override,
 *     independent of which hold mode was picked. A facilitator can set a
 *     rate with no timer and still choose to wean it off later; a timed
 *     override can still be cut immediately before its clock expires.
 * This is fewer states to reason about, and matches how a real infusion
 * titration actually works (set a rate, then separately decide to stop or
 * wean it) more closely than a flat 4-way radio choice would.
 *
 * "Release" always targets the value at that path from the INSTANT BEFORE
 * this override was applied (`priorValue`, snapshotted once, frozen) - not
 * a live-recomputed "what would the script say right now" value. A moving
 * target would need runner.state to fork into a separate override-free
 * baseline that keeps evolving underneath, tracked independently forever;
 * this is simpler, fully predictable to a facilitator, and correct for the
 * common case (no ramp active on that field). The one edge case it doesn't
 * chase: if a scripted ramp targeting the SAME field was running underneath
 * an override the whole time, its `fromState` was already rebased to the
 * override value (see applyFacilitatorOverride's docstring) - so the ramp
 * itself continues normally from wherever the override left it; releasing
 * back to `priorValue` in that specific case moves backward relative to
 * where the ramp has since progressed. Flagged, not solved - revisit only
 * if a real session needs it. See CLAUDE.md.
 * ========================================================================= */

/**
 * Set a single-path override with a chosen release behavior. `opts.releaseMode`
 * is 'hold' (default - persists until explicitly released) or 'duration'
 * (also schedules an automatic, immediate release after `opts.releaseMinutes`,
 * fired by checkOverrideReleases() - same "scheduled up front, fired by a
 * check function every tick" pattern as pendingAutoAdvance). Calling this
 * again on a path that's ALREADY overridden (e.g. every 'input' event fired
 * during one continuous slider drag, or a manual-entry commit right after a
 * drag) updates the value/releaseMode in place but does NOT re-snapshot
 * priorValue - it keeps the one taken the first time this path became
 * overridden. Real bug this fixes: the console's slider handler calls this
 * on every drag tick, and the old code read `priorValue` fresh from
 * runner.state each time - which by the second tick was already the
 * previous tick's OVERRIDE value, not the original pre-override/scripted
 * one. So "Release Now"/"Release Over N min" only ever reverted by one drag
 * frame instead of back to where the field actually started - reported by a
 * user as the release buttons "don't seem to work or make sense." Only
 * re-snapshot when the path isn't already in runner.overrides; releasing
 * (releaseOverrideNow/startGradualRelease) always clears that entry first,
 * so the next genuinely-new override on that path snapshots fresh again.
 */
export function setOverrideWithRelease(runner, path, value, opts = {}, nowMs) {
  const { releaseMode = 'hold', releaseMinutes } = opts;
  const priorValue = runner.overrides[path] ? runner.overrides[path].priorValue : getPath(runner.state, path);
  const patch = setPathImmutable({}, path, value);
  const state = applyInstant(runner.state, patch);
  const activeRamp = runner.activeRamp
    ? { ...runner.activeRamp, fromState: applyInstant(runner.activeRamp.fromState, patch) }
    : null;
  const releaseAt = releaseMode === 'duration' && typeof releaseMinutes === 'number'
    ? nowMs + releaseMinutes * 60000
    : null;
  const overrides = { ...runner.overrides, [path]: { releaseMode, releaseAt, priorValue } };
  const releaseRamps = { ...runner.releaseRamps };
  delete releaseRamps[path];
  return { ...runner, state, activeRamp, overrides, releaseRamps };
}

/** Drop the override at `path` immediately - its pre-override value shows again with no ramp. No-op if `path` isn't overridden. */
export function releaseOverrideNow(runner, path) {
  if (!runner.overrides[path]) return runner;
  const { priorValue } = runner.overrides[path];
  const patch = setPathImmutable({}, path, priorValue);
  const state = applyInstant(runner.state, patch);
  const overrides = { ...runner.overrides }; delete overrides[path];
  const releaseRamps = { ...runner.releaseRamps }; delete releaseRamps[path];
  return { ...runner, state, overrides, releaseRamps };
}

/**
 * Ramp the override at `path` back toward its pre-override value over
 * `releaseMinutes`, instead of snapping instantly. Reuses rampState()'s
 * fixed-target interpolation and NUMERIC_PATHS whitelist directly - only
 * ramp-able fields can be gradually released, the same restriction a
 * scripted ramp step already has and for the same reason (a discrete field
 * like rhythm has no meaningful "partway" value). No-op if `path` isn't
 * currently overridden. tick() must be called for this to actually progress
 * - see tickReleaseRamps() below, which tick() calls internally.
 */
export function startGradualRelease(runner, path, releaseMinutes, nowMs) {
  if (!runner.overrides[path]) return runner;
  const { priorValue } = runner.overrides[path];
  const fromValue = getPath(runner.state, path);
  const durationMs = (releaseMinutes || 0) * 60000;
  const overrides = { ...runner.overrides }; delete overrides[path];
  const releaseRamps = { ...runner.releaseRamps, [path]: { fromValue, toValue: priorValue, startedAtMs: nowMs, durationMs } };
  return { ...runner, overrides, releaseRamps };
}

/** Progress any in-flight gradual releases toward their target. Internal - called by tick(); exported for tests. */
export function tickReleaseRamps(runner, nowMs) {
  const paths = Object.keys(runner.releaseRamps);
  if (paths.length === 0) return runner;
  let state = runner.state;
  const releaseRamps = { ...runner.releaseRamps };
  for (const path of paths) {
    const { fromValue, toValue, startedAtMs, durationMs } = releaseRamps[path];
    const fraction = durationMs <= 0 ? 1 : (nowMs - startedAtMs) / durationMs;
    // Force the "from" value rampState reads at this path to the frozen
    // fromValue (not whatever state currently holds there) so every call
    // recomputes fresh from a fixed start, same pattern tick() uses for
    // activeRamp - never accumulate across ticks.
    state = rampState(setPathImmutable(state, path, fromValue), setPathImmutable({}, path, toValue), fraction);
    if (fraction >= 1) delete releaseRamps[path];
  }
  return { ...runner, state, releaseRamps };
}

/**
 * Read-only override status at `path`, for the UI. Returns null if `path`
 * isn't currently overridden or releasing. `{status:'held', releaseMode,
 * remainingMs}` (remainingMs null for an indefinite hold) or
 * `{status:'releasing', fraction}` while a gradual release is in flight.
 */
export function getOverrideInfo(runner, path, nowMs) {
  const held = runner.overrides[path];
  if (held) {
    return {
      status: 'held',
      releaseMode: held.releaseMode,
      remainingMs: held.releaseAt != null ? Math.max(0, held.releaseAt - nowMs) : null,
    };
  }
  const releasing = runner.releaseRamps[path];
  if (releasing) {
    const fraction = releasing.durationMs <= 0 ? 1 : Math.min(1, (nowMs - releasing.startedAtMs) / releasing.durationMs);
    return { status: 'releasing', fraction };
  }
  return null;
}

/** Is `path` currently overridden (held OR mid-gradual-release)? */
export function isOverridden(runner, path) {
  return !!(runner.overrides[path] || runner.releaseRamps[path]);
}

/**
 * If any 'duration' override's release time has passed, release it
 * immediately (same "scheduled up front, fired by a check every tick"
 * pattern as checkAutoAdvance). Call every tick alongside tick(). A no-op
 * for overrides with no releaseAt (indefinite holds).
 */
export function checkOverrideReleases(runner, nowMs) {
  let result = runner;
  for (const path of Object.keys(runner.overrides)) {
    const ov = runner.overrides[path];
    if (ov.releaseMode === 'duration' && ov.releaseAt != null && nowMs >= ov.releaseAt) {
      result = releaseOverrideNow(result, path);
    }
  }
  return result;
}
