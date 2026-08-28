import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraphRunner, reset, advanceToStage, tick, checkAutoAdvance, chooseBranch, currentStage,
  setOverrideWithRelease, releaseOverrideNow, getOverrideInfo, applyFacilitatorOverride,
  startFacilitatorRamp, getRampProgress, getAutoAdvanceCountdown, cancelAutoAdvance,
} from './stageRunner.js';

// A small branching fixture: baseline -> ramp (with a timed auto-advance) ->
// branch (facilitator picks stabilize-or-arrest) -> two distinct endpoints.
function fixtureScenario() {
  return {
    schemaVersion: '2.0.0',
    id: 'fixture-v2',
    title: 'Fixture v2 scenario',
    baseline: { hr: 90, bp: { sbp: 110, dbp: 70, map: 73 } },
    startStageId: 'baseline',
    stages: [
      { id: 'baseline', type: 'baseline' },
      {
        id: 'decline', type: 'deterioration', target: { hr: 135, bp: { sbp: 72, dbp: 58 } },
        transitionDuration: 5, holdDuration: 2, destinationIfUnaddressed: 'choice',
      },
      {
        id: 'choice', type: 'branch',
        branches: [
          { label: 'Stabilized', destinationId: 'stabilized' },
          { label: 'No intervention', destinationId: 'arrest' },
        ],
      },
      { id: 'stabilized', type: 'intervention-response', set: { hr: 85, bp: { sbp: 105, dbp: 68 } } },
      { id: 'arrest', type: 'arrest', set: { rhythm: 'PEA', flags: { arrestActive: true } } },
      { id: 'debrief', type: 'discussion', prompt: 'What did you notice?' },
      // A stage combining `target` (a ramp) with `set` (an instant patch on
      // a DIFFERENT field than what's ramping) - found via a real worked
      // scenario (a post-CABG AV-block case) where `set`'s rhythm change
      // was silently discarded the moment the first tick() ran, because
      // activeRamp.fromState was captured BEFORE `set` merged in, and
      // rampState() reconstructs state fresh from fromState every call.
      { id: 'declineWithRhythmChange', type: 'deterioration', target: { hr: 70 }, transitionDuration: 5, set: { rhythm: 'First-Degree AV Block' } },
    ],
  };
}

test('createGraphRunner starts at startStageId (or stages[0] if omitted) with the authored baseline', () => {
  const r = createGraphRunner(fixtureScenario());
  assert.equal(r.currentStageId, 'baseline');
  assert.equal(r.state.hr, 90);
  assert.deepEqual(r.history, ['baseline']);
  assert.equal(r.activeRamp, null);
  assert.equal(r.pendingAutoAdvance, null);
});

test('createGraphRunner defaults to stages[0].id when startStageId is omitted', () => {
  const s = fixtureScenario();
  delete s.startStageId;
  const r = createGraphRunner(s);
  assert.equal(r.currentStageId, 'baseline');
});

test('advanceToStage into a ramp stage starts the ramp without moving state yet, and schedules the timed auto-advance up front', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  assert.equal(r.currentStageId, 'decline');
  assert.equal(r.state.hr, 90); // unchanged - tick() progresses it
  assert.ok(r.activeRamp);
  assert.equal(r.activeRamp.durationMs, 5 * 60000);
  assert.deepEqual(r.pendingAutoAdvance, { fireAtMs: (5 + 2) * 60000, kind: 'stage', destinationId: 'choice' });
});

test('tick() interpolates the ramp and completes it, independent of pendingAutoAdvance', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 150000); // halfway
  assert.equal(r.state.hr, 112.5);
  assert.ok(r.activeRamp);

  r = tick(r, 300000); // full duration
  assert.equal(r.state.hr, 135);
  assert.equal(r.activeRamp, null);
  assert.ok(r.pendingAutoAdvance); // still pending - unaffected by the ramp settling
});

test('checkAutoAdvance is a no-op before the deadline, and advances to destinationIfUnaddressed exactly at it', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 300000);

  r = checkAutoAdvance(r, 7 * 60000 - 60000); // 1 minute before the 5+2=7min deadline
  assert.equal(r.currentStageId, 'decline');

  r = checkAutoAdvance(r, 7 * 60000); // exactly at the 5+2=7min deadline
  assert.equal(r.currentStageId, 'choice');
  assert.equal(r.pendingAutoAdvance, null); // 'choice' is a branch stage with no holdDuration of its own
});

test('advanceToStage force-settles an in-flight ramp to its target before moving on (never leaves mid-interpolation)', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 60000); // only 1 of 5 minutes elapsed
  assert.notEqual(r.state.hr, 135);

  r = advanceToStage(r, 'choice', 60000); // facilitator manually skips ahead before the ramp finished
  assert.equal(r.currentStageId, 'choice');
  assert.equal(r.state.hr, 135); // settled to the ramp's target on the way out
  assert.equal(r.activeRamp, null);
});

test('chooseBranch moves to the picked destination and applies its own set patch', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 300000);
  r = advanceToStage(r, 'choice', 420000);

  r = chooseBranch(r, 'stabilized', 420000);
  assert.equal(r.currentStageId, 'stabilized');
  assert.equal(r.state.hr, 85);
  assert.equal(r.state.bp.sbp, 105);
});

test('the other branch leads to a genuinely distinct endpoint - this is real branching, not a fixed script', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 300000);
  r = advanceToStage(r, 'choice', 420000);

  r = chooseBranch(r, 'arrest', 420000);
  assert.equal(r.currentStageId, 'arrest');
  assert.equal(r.state.rhythm, 'PEA');
  assert.equal(r.state.flags.arrestActive, true);
});

test('currentStage() returns the full stage definition for UI rendering', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'choice', 0);
  const stage = currentStage(r);
  assert.equal(stage.type, 'branch');
  assert.equal(stage.branches.length, 2);
});

test('a discussion stage changes no state fields', () => {
  let r = createGraphRunner(fixtureScenario());
  const before = r.state;
  r = advanceToStage(r, 'debrief', 0);
  assert.deepEqual(r.state, before);
  assert.equal(r.activeRamp, null);
});

test('reset() returns to the scenario\'s start stage and fresh baseline', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 300000);
  r = reset(r);
  assert.equal(r.currentStageId, 'baseline');
  assert.equal(r.state.hr, 90);
  assert.deepEqual(r.history, ['baseline']);
  assert.deepEqual(r.events, []);
});

test('advanceToStage throws on an unknown stage id, same as v1\'s jumpToPart on an unknown part id', () => {
  const r = createGraphRunner(fixtureScenario());
  assert.throws(() => advanceToStage(r, 'nope-not-real', 0), /Unknown stage id/);
});

test('history accumulates every stage visited, in order, across branches', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = advanceToStage(r, 'choice', 300000);
  r = chooseBranch(r, 'stabilized', 300000);
  assert.deepEqual(r.history, ['baseline', 'decline', 'choice', 'stabilized']);
});

/* ---------------- Reused-as-is primitives from scenarioRunner.js ---------------- */

test('applyFacilitatorOverride and the full override-release primitive work identically on a graph runner (reused, not reimplemented)', () => {
  let r = createGraphRunner(fixtureScenario());
  r = setOverrideWithRelease(r, 'hr', 40, {}, 0);
  assert.equal(r.state.hr, 40);
  assert.deepEqual(getOverrideInfo(r, 'hr', 0), { status: 'held', releaseMode: 'hold', remainingMs: null });

  r = releaseOverrideNow(r, 'hr');
  assert.equal(r.state.hr, 90);
  assert.equal(getOverrideInfo(r, 'hr', 0), null);
});

test('advanceToStage clears overrides/releaseRamps, same navigation convention as v1', () => {
  let r = createGraphRunner(fixtureScenario());
  r = setOverrideWithRelease(r, 'hr', 40, {}, 0);
  assert.ok(Object.keys(r.overrides).length);

  r = advanceToStage(r, 'debrief', 0);
  assert.deepEqual(r.overrides, {});
  assert.deepEqual(r.releaseRamps, {});
});

test('startFacilitatorRamp (Custom Decline) works on a graph runner exactly as on a v1 runner, including firing a custom outcome without moving currentStageId', () => {
  let r = createGraphRunner(fixtureScenario());
  const stageBefore = r.currentStageId;
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 1, autoAdvanceAfterMinutes: 1,
    outcomePatch: { rhythm: 'VF', flags: { arrestActive: true } }, label: 'v-fib',
  }, 0);
  r = tick(r, 60000);
  r = checkAutoAdvance(r, 120000);
  assert.equal(r.currentStageId, stageBefore); // untouched - custom declines never move the graph position
  assert.equal(r.state.rhythm, 'VF');
  assert.equal(r.state.flags.arrestActive, true);
});

test('cancelAutoAdvance stops a pending timed stage-advance from firing', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  r = tick(r, 300000);
  r = cancelAutoAdvance(r);
  r = checkAutoAdvance(r, 999 * 60000);
  assert.equal(r.currentStageId, 'decline'); // never advanced, held indefinitely
});

test('getRampProgress/getAutoAdvanceCountdown report correctly on a graph runner', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'decline', 0);
  assert.deepEqual(getRampProgress(r, 150000), { elapsedMs: 150000, durationMs: 300000, fraction: 0.5, remainingMs: 150000 });
  r = tick(r, 300000);
  assert.deepEqual(getAutoAdvanceCountdown(r, 300000), { remainingMs: 2 * 60000, label: null });
});

test('a stage combining target (ramp) and set (instant patch on a different field) keeps the set field through tick(), not just for the instant between advanceToStage and the first tick', () => {
  let r = createGraphRunner(fixtureScenario());
  r = advanceToStage(r, 'declineWithRhythmChange', 0);
  assert.equal(r.state.rhythm, 'First-Degree AV Block'); // applied immediately, as documented
  r = tick(r, 150000); // halfway through the 5-minute ramp
  assert.equal(r.state.rhythm, 'First-Degree AV Block'); // must NOT have reverted mid-ramp
  assert.equal(r.state.hr, 90 - (90 - 70) * 0.5); // hr is genuinely mid-ramp
  r = tick(r, 300000); // ramp fully settled
  assert.equal(r.state.rhythm, 'First-Degree AV Block'); // still correct after settling
  assert.equal(r.state.hr, 70);
});
