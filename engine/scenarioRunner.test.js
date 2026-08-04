import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunner, next, prev, reset, jumpToPart, tick, applyFacilitatorOverride,
  getRampProgress, checkAutoAdvance, getAutoAdvanceCountdown, cancelAutoAdvance,
  startFacilitatorRamp,
} from './scenarioRunner.js';

// Small synthetic fixture, independent of the real flagship scenario (that
// gets its own end-to-end test) - just enough shape to exercise every step
// type and every part-boundary case.
function fixtureScenario() {
  return {
    id: 'fixture',
    title: 'Fixture scenario',
    parts: [
      {
        id: 'partA',
        title: 'Part A',
        initialState: { hr: 90, bp: { sbp: 110, dbp: 70, map: 73 } },
        steps: [
          { id: 'a-ramp', type: 'ramp', durationMinutes: 5, target: { hr: 135, bp: { sbp: 72, dbp: 58, map: 65 } }, coach: 'ramping' },
          { id: 'a-arrest', type: 'event', set: { rhythm: 'PEA', flags: { arrestActive: true } }, coach: 'arrest' },
          { id: 'a-talk', type: 'discussion', prompt: 'What now?' },
        ],
      },
      {
        id: 'partB',
        title: 'Part B',
        initialState: { hr: 140, bp: { sbp: 78, dbp: 60, map: 63 } },
        steps: [
          { id: 'b-instant', type: 'instant', set: { hr: 150 }, coach: 'bump' },
        ],
      },
    ],
  };
}

test('createRunner starts at part 0 initialState with stepIndex -1', () => {
  const r = createRunner(fixtureScenario());
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, -1);
  assert.equal(r.state.hr, 90);
  assert.equal(r.activeRamp, null);
});

test('next() into a ramp step starts the ramp without moving the state yet', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0);
  assert.equal(r.stepIndex, 0);
  assert.equal(r.state.hr, 90); // unchanged - fromState until ticked
  assert.ok(r.activeRamp);
  assert.equal(r.activeRamp.durationMs, 5 * 60000);
});

test('tick() interpolates a ramp partway and completes it at duration', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); // start the 5-minute ramp at t=0
  r = tick(r, 150000); // halfway (2.5 of 5 min)
  assert.equal(r.state.hr, 112.5);
  assert.ok(r.activeRamp); // still in flight

  r = tick(r, 300000); // full duration
  assert.equal(r.state.hr, 135);
  assert.equal(r.activeRamp, null); // ramp cleared on completion
});

test('next() called mid-ramp force-settles the current step before advancing', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); // start ramp
  r = tick(r, 60000); // only 1 of 5 minutes elapsed - nowhere near target
  assert.notEqual(r.state.hr, 135);

  r = next(r, 60000); // advance to a-arrest before the ramp finished
  assert.equal(r.stepIndex, 1);
  assert.equal(r.state.hr, 135); // settled to the ramp's target on the way out
  assert.equal(r.state.rhythm, 'PEA');
  assert.equal(r.state.flags.arrestActive, true);
  assert.equal(r.activeRamp, null);
});

test('discussion step changes no state fields', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); // ramp
  r = next(r, 300000); // event (ramp settles to hr 135)
  const beforeTalk = r.state;
  r = next(r, 300000); // discussion
  assert.equal(r.stepIndex, 2);
  assert.deepEqual(r.state, beforeTalk);
});

test('next() across a part boundary lands on the new part initialState first', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); r = next(r, 0); r = next(r, 0); // consume all of part A's steps
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, 2);

  r = next(r, 0); // cross into part B
  assert.equal(r.partIndex, 1);
  assert.equal(r.stepIndex, -1);
  assert.equal(r.state.hr, 140); // partB.initialState, NOT carried forward from part A's 135

  r = next(r, 0); // now apply partB's first step
  assert.equal(r.stepIndex, 0);
  assert.equal(r.state.hr, 150);
});

test('next() at the very end of the last part is a no-op', () => {
  let r = createRunner(fixtureScenario());
  for (let i = 0; i < 10; i++) r = next(r, 0); // walk well past the end
  assert.equal(r.partIndex, 1);
  assert.equal(r.stepIndex, 0);
  assert.equal(r.state.hr, 150);
});

test('prev() steps backward, including back across a part boundary', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); r = next(r, 0); r = next(r, 0); r = next(r, 0); r = next(r, 0);
  // now at partB, stepIndex 0 (hr 150)
  r = prev(r);
  assert.equal(r.partIndex, 1);
  assert.equal(r.stepIndex, -1);
  assert.equal(r.state.hr, 140);

  r = prev(r); // cross back into part A's last step
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, 2);
  assert.equal(r.state.rhythm, 'PEA'); // settled state at that step, discussion step is a no-op on top
});

test('prev() at the very start is a no-op', () => {
  let r = createRunner(fixtureScenario());
  r = prev(r);
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, -1);
});

test('reset() returns to the initial runner state', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); r = next(r, 300000);
  r = reset(r);
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, -1);
  assert.equal(r.state.hr, 90);
  assert.deepEqual(r.events, []);
});

test('jumpToPart() jumps straight to a part\'s initialState', () => {
  let r = createRunner(fixtureScenario());
  r = jumpToPart(r, 'partB');
  assert.equal(r.partIndex, 1);
  assert.equal(r.stepIndex, -1);
  assert.equal(r.state.hr, 140);
});

test('jumpToPart() throws on an unknown part id', () => {
  const r = createRunner(fixtureScenario());
  assert.throws(() => jumpToPart(r, 'nope'), /Unknown part id/);
});

test('applyFacilitatorOverride() nudges current state immediately', () => {
  let r = createRunner(fixtureScenario());
  r = applyFacilitatorOverride(r, { cvp: 20 });
  assert.equal(r.state.cvp, 20);
  assert.equal(r.state.hr, 90); // untouched
});

test('applyFacilitatorOverride() mid-ramp rebases the ramp instead of being clobbered by the next tick', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); // start the 5-min hr 90->135 ramp at t=0
  r = tick(r, 150000); // halfway: hr 112.5
  assert.equal(r.state.hr, 112.5);

  r = applyFacilitatorOverride(r, { hr: 100 }); // facilitator manually nudges hr down
  assert.equal(r.state.hr, 100);

  r = tick(r, 300000); // ramp reaches full duration - continues toward the SAME target (135) from the overridden baseline (100), not the pre-override trajectory
  assert.equal(r.state.hr, 135); // still lands on the original target at fraction 1
});

test('events log records each navigation step', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0);
  r = next(r, 0);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].at, 'a-ramp');
  assert.equal(r.events[1].at, 'a-arrest');
});

test('getRampProgress() is null when nothing is ramping, and reports elapsed/remaining/fraction mid-ramp', () => {
  let r = createRunner(fixtureScenario());
  assert.equal(getRampProgress(r, 0), null);

  r = next(r, 0); // start the 5-min ramp at t=0
  assert.deepEqual(getRampProgress(r, 0), { elapsedMs: 0, durationMs: 300000, fraction: 0, remainingMs: 300000 });
  assert.deepEqual(getRampProgress(r, 150000), { elapsedMs: 150000, durationMs: 300000, fraction: 0.5, remainingMs: 150000 });
  // past the end but before tick() has cleared activeRamp - fraction clamps to 1, remaining to 0
  assert.deepEqual(getRampProgress(r, 999999), { elapsedMs: 999999, durationMs: 300000, fraction: 1, remainingMs: 0 });
});

// Separate fixture: partA's ramp step additionally opts into auto-advance
// (arrest fires on its own 3 minutes after the 5-minute ramp settles, if the
// facilitator hasn't already moved on) - kept distinct from fixtureScenario()
// so the base fixture's tests stay unaffected by this optional field.
function fixtureScenarioWithAutoAdvance() {
  const s = fixtureScenario();
  s.parts[0].steps[0].autoAdvanceAfterMinutes = 3;
  return s;
}

test('a ramp step without autoAdvanceAfterMinutes never schedules a pendingAutoAdvance', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0);
  assert.equal(r.pendingAutoAdvance, null);
  r = tick(r, 300000); // ramp settles
  assert.equal(r.pendingAutoAdvance, null);
  assert.equal(checkAutoAdvance(r, 10000000), r); // no-op, same reference back
});

test('next() into a ramp step with autoAdvanceAfterMinutes schedules pendingAutoAdvance at start+duration+grace', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0); // ramp starts at t=0, 5 min duration + 3 min grace = fires at 8 min
  assert.deepEqual(r.pendingAutoAdvance, { fireAtMs: 8 * 60000, kind: 'scripted' });
});

test('checkAutoAdvance() is a no-op before the fire time, even after the ramp itself has settled', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0);
  r = tick(r, 300000); // ramp settles at t=5min
  assert.equal(r.activeRamp, null);
  assert.equal(r.stepIndex, 0); // still on the ramp step - nothing has advanced

  r = checkAutoAdvance(r, 300000 + 1000); // just after settling, well before the 8-min grace deadline
  assert.equal(r.stepIndex, 0);
});

test('checkAutoAdvance() fires next() automatically once the grace period elapses', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0);
  r = tick(r, 300000);
  r = checkAutoAdvance(r, 8 * 60000); // exactly at the fire time
  assert.equal(r.stepIndex, 1); // advanced to a-arrest, same as a manual Next
  assert.equal(r.state.rhythm, 'PEA');
  assert.equal(r.state.flags.arrestActive, true);
  assert.equal(r.pendingAutoAdvance, null); // cleared by the next() it triggered
});

test('getAutoAdvanceCountdown() reports remaining time, null when nothing is pending', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  assert.equal(getAutoAdvanceCountdown(r, 0), null);

  r = next(r, 0);
  r = tick(r, 300000);
  assert.deepEqual(getAutoAdvanceCountdown(r, 300000), { remainingMs: 3 * 60000, label: null });
  assert.deepEqual(getAutoAdvanceCountdown(r, 8 * 60000 - 1000), { remainingMs: 1000, label: null });
});

test('cancelAutoAdvance() clears a pending auto-advance without changing anything else', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0);
  r = tick(r, 300000);
  const stateBefore = r.state;
  r = cancelAutoAdvance(r);
  assert.equal(r.pendingAutoAdvance, null);
  assert.equal(r.state, stateBefore); // untouched
  assert.equal(r.stepIndex, 0); // still parked on the ramp step

  r = checkAutoAdvance(r, 999 * 60000); // long past the original fire time - stays put, it was cancelled
  assert.equal(r.stepIndex, 0);
});

test('a manual next() before the grace period elapses cancels the pending auto-advance (no double-fire)', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0); // start ramp, schedules fireAtMs = 8min
  r = tick(r, 60000); // 1 min in, nowhere near settled
  r = next(r, 60000); // facilitator manually advances early (force-settles the ramp, same as existing behavior)
  assert.equal(r.stepIndex, 1);
  assert.equal(r.pendingAutoAdvance, null);
});

test('prev() and jumpToPart() also clear a pending auto-advance', () => {
  let r = createRunner(fixtureScenarioWithAutoAdvance());
  r = next(r, 0);
  r = tick(r, 300000);
  assert.ok(r.pendingAutoAdvance);

  let rPrev = prev(r);
  assert.equal(rPrev.pendingAutoAdvance, null);

  let rJump = jumpToPart(r, 'partB');
  assert.equal(rJump.pendingAutoAdvance, null);
});

/* ---------------- startFacilitatorRamp() - SME-timed custom decline ---------------- */

test('startFacilitatorRamp() starts a ramp toward a custom target from the current state, independent of partIndex/stepIndex', () => {
  let r = createRunner(fixtureScenario()); // partIndex 0, stepIndex -1, no scripted ramp involved at all
  r = startFacilitatorRamp(r, { target: { hr: 40 }, durationMinutes: 4 }, 1000);
  assert.equal(r.partIndex, 0);
  assert.equal(r.stepIndex, -1); // untouched - this is not a scripted-step transition
  assert.ok(r.activeRamp);
  assert.equal(r.activeRamp.fromState.hr, 90); // ramping from wherever the state currently was
  assert.equal(r.activeRamp.startedAtMs, 1000);
  assert.equal(r.activeRamp.durationMs, 4 * 60000);
  assert.equal(r.pendingAutoAdvance, null); // no autoAdvanceAfterMinutes/outcomePatch given - decline-only, no auto-fire
});

test('startFacilitatorRamp() ticks and settles exactly like a scripted ramp', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, { target: { hr: 40 }, durationMinutes: 4 }, 0);
  r = tick(r, 120000); // halfway
  assert.equal(r.state.hr, 65);
  r = tick(r, 240000); // full duration
  assert.equal(r.state.hr, 40);
  assert.equal(r.activeRamp, null);
});

test('startFacilitatorRamp() with autoAdvanceAfterMinutes + outcomePatch schedules a custom pendingAutoAdvance', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2,
    outcomePatch: { rhythm: 'PEA', flags: { arrestActive: true } }, label: 'cardiac arrest',
  }, 0);
  assert.deepEqual(r.pendingAutoAdvance, {
    fireAtMs: 6 * 60000, kind: 'custom', patch: { rhythm: 'PEA', flags: { arrestActive: true } }, label: 'cardiac arrest',
  });
});

test('startFacilitatorRamp() without BOTH autoAdvanceAfterMinutes and outcomePatch never schedules an auto-fire (decline-only)', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, { target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2 }, 0); // no outcomePatch
  assert.equal(r.pendingAutoAdvance, null);
  r = startFacilitatorRamp(r, { target: { hr: 40 }, durationMinutes: 4, outcomePatch: { rhythm: 'PEA' } }, 0); // no autoAdvanceAfterMinutes
  assert.equal(r.pendingAutoAdvance, null);
});

test('checkAutoAdvance() applies the custom outcome patch on fire, WITHOUT touching partIndex/stepIndex', () => {
  let r = createRunner(fixtureScenario());
  r = next(r, 0); r = next(r, 0); // walk to partA's a-arrest step first, so we're mid-scenario
  const partBefore = r.partIndex, stepBefore = r.stepIndex;
  r = startFacilitatorRamp(r, {
    target: { hr: 200 }, durationMinutes: 1, autoAdvanceAfterMinutes: 1,
    outcomePatch: { rhythm: 'VF', flags: { arrestActive: true } }, label: 'v-fib',
  }, 0);
  r = tick(r, 60000); // ramp settles
  r = checkAutoAdvance(r, 120000); // grace period elapses
  assert.equal(r.partIndex, partBefore);
  assert.equal(r.stepIndex, stepBefore); // untouched by the custom auto-advance
  assert.equal(r.state.rhythm, 'VF');
  assert.equal(r.state.flags.arrestActive, true);
  assert.equal(r.activeRamp, null);
  assert.equal(r.pendingAutoAdvance, null);
});

test('checkAutoAdvance() for a custom decline is a no-op before the deadline', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2,
    outcomePatch: { rhythm: 'PEA' },
  }, 0);
  r = checkAutoAdvance(r, 5 * 60000); // 5 min in, deadline is at 6 min
  assert.notEqual(r.state.rhythm, 'PEA');
  assert.ok(r.pendingAutoAdvance);
});

test('cancelAutoAdvance() also cancels a custom (facilitator-timed) auto-advance', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2,
    outcomePatch: { rhythm: 'PEA' },
  }, 0);
  r = tick(r, 240000);
  r = cancelAutoAdvance(r);
  assert.equal(r.pendingAutoAdvance, null);
  r = checkAutoAdvance(r, 999 * 60000);
  assert.notEqual(r.state.rhythm, 'PEA');
});

test('getAutoAdvanceCountdown() surfaces the custom decline\'s label for the UI', () => {
  let r = createRunner(fixtureScenario());
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2,
    outcomePatch: { rhythm: 'PEA' }, label: 'sepsis-driven arrest',
  }, 0);
  r = tick(r, 240000);
  assert.deepEqual(getAutoAdvanceCountdown(r, 240000), { remainingMs: 120000, label: 'sepsis-driven arrest' });
});

test('next()/prev()/jumpToPart() also cancel an in-flight custom decline (activeRamp and pendingAutoAdvance alike)', () => {
  // Start from partB, whose only step ('b-instant') is NOT itself a ramp -
  // isolates "does next() clear the custom ramp" from "does the destination
  // step happen to start its own new ramp" (partA's first step is a ramp,
  // which would confound this assertion).
  let r = jumpToPart(createRunner(fixtureScenario()), 'partB');
  r = startFacilitatorRamp(r, {
    target: { hr: 40 }, durationMinutes: 4, autoAdvanceAfterMinutes: 2,
    outcomePatch: { rhythm: 'PEA' },
  }, 0);
  assert.ok(r.activeRamp);
  assert.ok(r.pendingAutoAdvance);

  const rNext = next(r, 0); // into b-instant
  assert.equal(rNext.activeRamp, null);
  assert.equal(rNext.pendingAutoAdvance, null);

  const rPrev = prev(r);
  assert.equal(rPrev.activeRamp, null);
  assert.equal(rPrev.pendingAutoAdvance, null);

  const rJump = jumpToPart(r, 'partA');
  assert.equal(rJump.activeRamp, null);
  assert.equal(rJump.pendingAutoAdvance, null);
});
