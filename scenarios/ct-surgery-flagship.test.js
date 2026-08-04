// End-to-end check that the authored flagship scenario actually plays
// correctly through engine/scenarioRunner.js - not just that the runner's
// mechanics work in the abstract (that's engine/scenarioRunner.test.js),
// but that THIS specific JSON produces the specific numbers the source
// case study calls for at each point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRunner, next, prev, tick, jumpToPart, checkAutoAdvance, cancelAutoAdvance,
} from '../engine/scenarioRunner.js';
import { getEffectiveRhythm } from '../engine/physiology.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(__dirname, 'ct-surgery-flagship.json'), 'utf8'));

test('scenario shape: 3 parts, ids match BUILD_PROMPT.md §4', () => {
  assert.equal(scenario.parts.length, 3);
  assert.deepEqual(scenario.parts.map((p) => p.id), [
    'part1-bedside-settlein',
    'part2-tamponade-arrest',
    'part3-ecmo-cannulation',
  ]);
});

test('Part 1: baseline snapshot matches the source, pacer captured so effective rhythm is paced', () => {
  const r = createRunner(scenario);
  assert.equal(r.state.hr, 90);
  assert.equal(r.state.bp.sbp, 102);
  assert.equal(r.state.bp.dbp, 65);
  assert.equal(r.state.pacer.mode, 'DDD');
  assert.equal(r.state.pacer.outputMa, 9);
  assert.equal(r.state.pacer.sensitivityMv, 1.5);
  assert.equal(getEffectiveRhythm(r.state), 'Paced (DDD)');
  assert.equal(scenario.parts[0].steps.length, 0); // assessment-only, no scripted transition
});

test('Part 2: entering the part resets to its own baseline, not Part 1\'s ending state', () => {
  let r = jumpToPart(createRunner(scenario), 'part2-tamponade-arrest');
  assert.equal(r.state.hr, 90);
  assert.equal(r.state.bp.sbp, 110); // different from Part 1's 102 - confirms independent snapshots
  assert.equal(r.state.pa.systolic, 38);
  assert.equal(r.state.cvp, 8);
});

test('Part 2: full walk-through - recent events, HR bump, 5-min tamponade ramp, arrest, sternotomy', () => {
  let r = jumpToPart(createRunner(scenario), 'part2-tamponade-arrest');

  r = next(r, 0); // recent-events (discussion, no state change)
  assert.equal(r.stepIndex, 0);
  assert.equal(r.state.hr, 90);

  r = next(r, 0); // tamponade-begins
  assert.equal(r.state.hr, 100);

  r = next(r, 0); // tamponade-onset ramp starts at t=0
  assert.ok(r.activeRamp);
  assert.equal(r.state.hr, 100); // hasn't moved yet

  r = tick(r, 150000); // 2.5 of 5 minutes
  assert.equal(r.state.hr, 117.5);
  assert.equal(r.state.bp.sbp, 91); // midpoint of 110->72
  assert.equal(r.state.pa.systolic, 41.5); // midpoint of 38->45

  r = next(r, 300000); // advance to arrest - force-settles the ramp to its target first
  assert.equal(r.stepIndex, 3);
  assert.equal(r.state.rhythm, 'PEA');
  assert.equal(r.state.hr, 150);
  assert.equal(r.state.bp.sbp, 0);
  assert.equal(r.state.bp.map, 0);
  assert.equal(r.state.spo2, 0);
  assert.equal(r.state.flags.arrestActive, true);
  assert.equal(getEffectiveRhythm(r.state), 'PEA'); // pacer capture is irrelevant during arrest - PEA shows regardless

  r = next(r, 300000); // sternotomy
  assert.equal(r.state.flags.sternotomyPerformed, true);
  assert.equal(r.state.flags.arrestActive, true); // arrest flag isn't cleared by the sternotomy event itself
});

test('Part 3: entering resets to its own baseline (post-sternotomy, pre-ECMO) independent of Part 2\'s ending state', () => {
  const r = jumpToPart(createRunner(scenario), 'part3-ecmo-cannulation');
  assert.equal(r.state.hr, 140);
  assert.equal(r.state.rhythm, 'Sinus Tachycardia');
  assert.equal(r.state.bp.sbp, 78);
  assert.equal(r.state.bp.map, 63);
  assert.equal(r.state.co, 4.0);
  assert.equal(r.state.ci, 1.7);
  assert.equal(r.state.svr, 1900);
  assert.equal(r.state.flags.sternotomyPerformed, true); // carried as an authored fact of this part's baseline, not literally "carried forward" from Part 2's engine state
  assert.equal(r.state.flags.ecmoCannulated, false);
  // intrinsic rate (140) exceeds pacer set rate (90) - demand-inhibited, not capturing
  assert.equal(getEffectiveRhythm(r.state), 'Sinus Tachycardia');
});

test('Part 3: discussion steps don\'t change state; the ECMO event step does', () => {
  let r = jumpToPart(createRunner(scenario), 'part3-ecmo-cannulation');
  const baseline = r.state;

  r = next(r, 0); // mcs-options (discussion)
  assert.deepEqual(r.state, baseline);

  r = next(r, 0); // ecmo-cannulated (event)
  assert.equal(r.state.flags.ecmoCannulated, true);

  r = next(r, 0); r = next(r, 0); // two more discussion steps
  assert.equal(r.stepIndex, 3);
  assert.equal(r.state.flags.ecmoCannulated, true); // still set - discussion steps don't reset it
});

test('Full run: next() from the very start walks all 3 parts to completion without error', () => {
  let r = createRunner(scenario);
  let guard = 0;
  while (guard++ < 50) {
    const before = r;
    r = next(r, guard * 60000);
    if (r === before) break; // no-op means we've reached the end
  }
  assert.equal(r.partIndex, 2);
  assert.equal(r.stepIndex, scenario.parts[2].steps.length - 1);
  assert.equal(r.state.flags.ecmoCannulated, true);
});

test('prev() from Part 3\'s baseline walks back into Part 2\'s final settled state', () => {
  let r = jumpToPart(createRunner(scenario), 'part3-ecmo-cannulation');
  r = prev(r);
  assert.equal(r.partIndex, 1);
  assert.equal(r.stepIndex, 4); // sternotomy, Part 2's last step
  assert.equal(r.state.flags.sternotomyPerformed, true);
});

test('Part 2: an unaddressed tamponade auto-arrests at minute 8 (5-min ramp + 3-min grace), matching the source\'s "At 8 min, patient goes into cardiac arrest"', () => {
  let r = jumpToPart(createRunner(scenario), 'part2-tamponade-arrest');
  r = next(r, 0); // recent-events
  r = next(r, 0); // tamponade-begins
  r = next(r, 0); // tamponade-onset ramp starts at t=0
  assert.deepEqual(r.pendingAutoAdvance, { fireAtMs: 8 * 60000, kind: 'scripted' });

  r = tick(r, 5 * 60000); // ramp settles at 5 min - not yet arrested
  r = checkAutoAdvance(r, 7 * 60000 + 59000); // 1 second before the deadline
  assert.equal(r.state.flags.arrestActive, false);

  r = checkAutoAdvance(r, 8 * 60000); // deadline reached, nobody called it manually
  assert.equal(r.state.rhythm, 'PEA');
  assert.equal(r.state.flags.arrestActive, true);
  assert.equal(getEffectiveRhythm(r.state), 'PEA');
});

test('Part 2: cancelAutoAdvance() lets the facilitator hold the pre-arrest tamponade state open past minute 8', () => {
  let r = jumpToPart(createRunner(scenario), 'part2-tamponade-arrest');
  r = next(r, 0); r = next(r, 0); r = next(r, 0); // into the ramp
  r = tick(r, 5 * 60000);
  r = cancelAutoAdvance(r);

  r = checkAutoAdvance(r, 60 * 60000); // long past minute 8 - still doesn't fire, it was cancelled
  assert.equal(r.state.flags.arrestActive, false);
  assert.equal(r.state.bp.sbp, 72); // parked at the settled tamponade values, not arrest's 0
});
