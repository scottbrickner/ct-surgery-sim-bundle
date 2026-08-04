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

import { createState, applyInstant, rampState } from './physiology.js';

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
    pendingAutoAdvance: null, // { fireAtMs } - see checkAutoAdvance()
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
        pendingAutoAdvance = { fireAtMs: nowMs + durationMs + step.autoAdvanceAfterMinutes * 60000 };
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
  };
}

/** Progress any in-flight ramp toward its target given the current wall-clock time. No-op if nothing is ramping. */
export function tick(runner, nowMs) {
  if (!runner.activeRamp) return runner;
  const { fromState, target, startedAtMs, durationMs } = runner.activeRamp;
  const fraction = durationMs <= 0 ? 1 : (nowMs - startedAtMs) / durationMs;
  const state = rampState(fromState, target, fraction);
  // pendingAutoAdvance (if any) is left untouched here - it was scheduled by
  // next() up front and fires via checkAutoAdvance(), independent of whether
  // the ramp itself has settled to activeRamp:null yet.
  return { ...runner, state, activeRamp: fraction >= 1 ? null : runner.activeRamp };
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
 */
export function checkAutoAdvance(runner, nowMs) {
  if (!runner.pendingAutoAdvance) return runner;
  if (nowMs < runner.pendingAutoAdvance.fireAtMs) return runner;
  return next(runner, nowMs);
}

/** Read-only view of a pending auto-advance, for rendering a countdown. Null if none is scheduled. */
export function getAutoAdvanceCountdown(runner, nowMs) {
  if (!runner.pendingAutoAdvance) return null;
  return { remainingMs: Math.max(0, runner.pendingAutoAdvance.fireAtMs - nowMs) };
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
 */
export function applyFacilitatorOverride(runner, patch) {
  const state = applyInstant(runner.state, patch);
  const activeRamp = runner.activeRamp
    ? { ...runner.activeRamp, fromState: applyInstant(runner.activeRamp.fromState, patch) }
    : null;
  return { ...runner, state, activeRamp };
}
