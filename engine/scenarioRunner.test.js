import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunner, next, prev, reset, jumpToPart, tick, applyFacilitatorOverride,
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
