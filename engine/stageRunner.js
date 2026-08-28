// Runtime for schema-v2 (stage graph) scenarios - see scenarios/schema-v2.md.
// Sibling to engine/scenarioRunner.js (v1, part/step/linear), NOT a fork of
// it: this module directly imports and reuses every part of
// scenarioRunner.js that's already generic (doesn't reference
// partIndex/stepIndex) - tick(), the whole override-release primitive,
// startFacilitatorRamp/applyFacilitatorOverride, and the ramp/auto-advance
// read-only helpers. Only navigation is genuinely different: v1 walks a
// fixed array by index; v2 walks a graph by stage id, with branches. See
// schema-v2.md's "why a new engine module" note for the full rationale -
// short version, this exists so v2 development can never risk the live,
// tested, in-production v1 runner.

import { createState, applyInstant, rampState } from './physiology.js';
import {
  tick as sharedTick,
  checkOverrideReleases, setOverrideWithRelease, releaseOverrideNow,
  startGradualRelease, getOverrideInfo, isOverridden,
  applyFacilitatorOverride, startFacilitatorRamp, advanceSimClock,
  getRampProgress, getAutoAdvanceCountdown, cancelAutoAdvance,
} from './scenarioRunner.js';

export {
  checkOverrideReleases, setOverrideWithRelease, releaseOverrideNow,
  startGradualRelease, getOverrideInfo, isOverridden,
  applyFacilitatorOverride, startFacilitatorRamp, advanceSimClock,
  getRampProgress, getAutoAdvanceCountdown, cancelAutoAdvance,
};

function findStage(scenario, stageId) {
  const stage = scenario.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Unknown stage id: ${stageId}`);
  return stage;
}

export function createGraphRunner(scenario) {
  const startId = scenario.startStageId || scenario.stages[0].id;
  return {
    scenario,
    currentStageId: startId,
    state: createState(scenario.baseline),
    activeRamp: null,
    pendingAutoAdvance: null, // { fireAtMs, kind: 'stage'|'custom', destinationId?, patch?, label? }
    overrides: {},
    releaseRamps: {},
    history: [startId],
    events: [],
  };
}

export function reset(runner) {
  return createGraphRunner(runner.scenario);
}

/**
 * Move the graph to `stageId` (any valid id in the scenario - a scripted
 * destination/branch target, or a facilitator/Builder-preview jump to
 * anywhere). Force-settles any in-flight ramp to its target first (same
 * "never leave mid-interpolation" rule v1's next() enforces via
 * computeStateAt), applies the destination stage's own target(ramp)/set
 * (instant), and schedules a new pendingAutoAdvance if the destination
 * stage has holdDuration+destinationIfUnaddressed. Clears
 * overrides/releaseRamps on any navigation, same convention as v1.
 */
export function advanceToStage(runner, stageId, nowMs) {
  const stage = findStage(runner.scenario, stageId);

  // Force-settle whatever was in flight before moving on.
  let settledState = runner.state;
  if (runner.activeRamp) {
    settledState = rampState(runner.activeRamp.fromState, runner.activeRamp.target, 1);
  }

  let state = settledState;
  let activeRamp = null;
  let pendingAutoAdvance = null;

  if (stage.target) {
    const durationMs = (stage.transitionDuration || 0) * 60000;
    // Real bug found and fixed via a live worked-example scenario (a
    // post-CABG progressive-AV-block case combining a `set` rhythm change
    // with a `target` HR ramp on the same stage - exactly the documented
    // "a ramp stage may ALSO carry a `set`" case just below): `set` MUST be
    // applied BEFORE activeRamp.fromState is captured, not after. tick()'s
    // ramp math (rampState(), see physiology.js) reconstructs the ENTIRE
    // state fresh from `fromState` every call, only overwriting whatever
    // fields are actually listed in `target` - any field `set` touched that
    // ISN'T also in `target` (rhythm, in this case) was silently discarded
    // the instant the very first tick() ran, even though it displayed
    // correctly for the one instant between advanceToStage() and the next
    // tick(). Confirmed by directly driving the scenario through the real
    // engine: rhythm showed the correct blocked rhythm immediately, then
    // reverted to the stage's OWN starting rhythm every time the ramp
    // settled - never caught before because no prior stage in this project
    // combined a rhythm `set` with a numeric `target` ramp on one stage.
    if (stage.set) state = applyInstant(settledState, stage.set); // a ramp stage may ALSO carry a `set` applied immediately (e.g. a flag flip, or a rhythm change, alongside the ramp)
    activeRamp = { fromState: state, target: stage.target, startedAtMs: nowMs, durationMs };
    // state stays at this (post-set) value until tick() progresses the ramp fields on top of it.
    if (typeof stage.holdDuration === 'number' && stage.destinationIfUnaddressed) {
      pendingAutoAdvance = { fireAtMs: nowMs + durationMs + stage.holdDuration * 60000, kind: 'stage', destinationId: stage.destinationIfUnaddressed };
    }
  } else if (stage.set) {
    state = applyInstant(settledState, stage.set);
    if (typeof stage.holdDuration === 'number' && stage.destinationIfUnaddressed) {
      pendingAutoAdvance = { fireAtMs: nowMs + stage.holdDuration * 60000, kind: 'stage', destinationId: stage.destinationIfUnaddressed };
    }
  }
  // branch/discussion stages with neither target nor set: state unchanged, awaiting a facilitator choice or manual advance.

  return {
    ...runner,
    currentStageId: stageId,
    state,
    activeRamp,
    pendingAutoAdvance,
    overrides: {},
    releaseRamps: {},
    history: [...runner.history, stageId],
    events: [...runner.events, { at: stageId, nowMs }],
  };
}

/** Progress any in-flight ramp AND any in-flight gradual override releases. Identical semantics to v1's tick() - reused directly, not reimplemented. */
export function tick(runner, nowMs) {
  return sharedTick(runner, nowMs);
}

/**
 * If a stage's holdDuration elapsed with no facilitator action, advance to
 * its destinationIfUnaddressed (kind:'stage') or apply a Custom-Decline-style
 * outcome patch in place without moving currentStageId (kind:'custom', same
 * as v1's startFacilitatorRamp-originated auto-advances - startFacilitatorRamp
 * is reused as-is from scenarioRunner.js, so a facilitator-timed custom
 * decline works identically here). No-op before the deadline or if nothing
 * is pending.
 */
export function checkAutoAdvance(runner, nowMs) {
  if (!runner.pendingAutoAdvance) return runner;
  if (nowMs < runner.pendingAutoAdvance.fireAtMs) return runner;
  if (runner.pendingAutoAdvance.kind === 'custom') {
    const { patch, label } = runner.pendingAutoAdvance;
    return {
      ...runner,
      state: applyInstant(runner.state, patch),
      activeRamp: null,
      pendingAutoAdvance: null,
      events: [...runner.events, { at: `custom-decline:${label || 'outcome'}`, nowMs }],
    };
  }
  return advanceToStage(runner, runner.pendingAutoAdvance.destinationId, nowMs);
}

/** Facilitator picks one of a `type:'branch'` stage's options. Equivalent to advanceToStage(runner, branch.destinationId, nowMs) - exported separately so the Builder/console UI can render branches[] directly rather than reaching into scenario structure itself. */
export function chooseBranch(runner, destinationId, nowMs) {
  return advanceToStage(runner, destinationId, nowMs);
}

/** The current stage's own definition object, for UI rendering (label, type, prompt, facilitatorNotes, branches, etc). */
export function currentStage(runner) {
  return findStage(runner.scenario, runner.currentStageId);
}
