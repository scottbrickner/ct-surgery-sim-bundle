// End-to-end check that the authored scenario actually plays correctly
// through engine/stageRunner.js - not just that the runner's mechanics work
// in the abstract (that's engine/stageRunner.test.js), but that THIS
// specific JSON produces the specific numbers/rhythms it's authored to at
// each stage. Also the scenario that surfaced the real stageRunner.js bug
// fixed alongside it (a `target` ramp combined with a `set` on a different
// field silently reverting on every tick) - see CLAUDE.md's Round 3 entry.
// Built via docs/scenario-builder-prompt.md, dogfooded against the real
// engine before being added here as a shipped asset, per direct request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createGraphRunner, advanceToStage, tick, checkAutoAdvance, chooseBranch, currentStage,
} from '../engine/stageRunner.js';
import { getEffectiveRhythm, getEffectiveHR } from '../engine/physiology.js';
import { validateScenarioV2 } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(__dirname, 'postcabg-progressive-avblock.json'), 'utf8'));

test('scenario validates against the real schema v2 validator', () => {
  assert.deepEqual(validateScenarioV2(scenario), { valid: true, errors: [] });
});

test('shape: 7 stages, ids in the authored order', () => {
  assert.equal(scenario.stages.length, 7);
  assert.deepEqual(scenario.stages.map((s) => s.id), [
    'stage1-baseline', 'stage2-first-degree', 'stage3-mobitz1', 'stage4-complete-heart-block',
    'stage5-branch', 'stage6a-paced-stable', 'stage6b-decompensation',
  ]);
});

test('baseline: POD1 sinus rhythm, epicardial wires in place but pacer off', () => {
  const r = createGraphRunner(scenario);
  assert.equal(r.currentStageId, 'stage1-baseline');
  assert.equal(r.state.hr, 82);
  assert.equal(r.state.rhythm, 'Sinus Rhythm');
  assert.equal(r.state.pacer.mode, 'off');
  assert.equal(r.state.pacer.captured, false);
  assert.equal(r.state.chestTubes.rMediastinal, 20);
});

test('Stage II: rhythm changes to First-Degree AV Block immediately, HR ramps to 74, and the rhythm SURVIVES the ramp settling (the bug this scenario found and fixed)', () => {
  let r = createGraphRunner(scenario);
  r = advanceToStage(r, 'stage2-first-degree', 0);
  assert.equal(r.state.rhythm, 'First-Degree AV Block'); // set applies immediately
  assert.equal(r.state.hr, 82); // ramp hasn't moved yet

  r = tick(r, 5 * 60000); // halfway through the 10-minute ramp
  assert.equal(r.state.rhythm, 'First-Degree AV Block'); // must NOT have reverted mid-ramp
  assert.equal(r.state.hr, 78);

  r = tick(r, 10 * 60000); // ramp settled
  assert.equal(r.state.rhythm, 'First-Degree AV Block');
  assert.equal(r.state.hr, 74);
});

test('unaddressed progression: Stage II -> III -> IV auto-advances on schedule, rhythm correct at every stage', () => {
  let r = createGraphRunner(scenario);
  r = advanceToStage(r, 'stage2-first-degree', 0);
  r = tick(r, 10 * 60000);
  r = checkAutoAdvance(r, 15 * 60000); // 10 min ramp + 5 min hold
  assert.equal(r.currentStageId, 'stage3-mobitz1');
  assert.equal(r.state.rhythm, 'Second-Degree AV Block (Type I)');

  r = tick(r, 25 * 60000); // +10 min ramp
  r = checkAutoAdvance(r, 30 * 60000); // +5 min hold
  assert.equal(r.currentStageId, 'stage4-complete-heart-block');
  assert.equal(r.state.rhythm, 'Third-Degree AV Block');

  r = tick(r, 35 * 60000); // +5 min ramp settles - complete heart block, symptomatic
  assert.equal(r.state.rhythm, 'Third-Degree AV Block');
  assert.equal(r.state.hr, 38);
  assert.equal(r.state.bp.map, 63);
  assert.equal(currentStage(r).advanceMode, 'manual'); // does not auto-advance further
});

test('branch: pacing initiated correctly -> paced rhythm displays automatically once captured, demand-inhibition-aware', () => {
  let r = createGraphRunner(scenario);
  r = advanceToStage(r, 'stage2-first-degree', 0);
  r = tick(r, 10 * 60000); r = checkAutoAdvance(r, 15 * 60000);
  r = tick(r, 25 * 60000); r = checkAutoAdvance(r, 30 * 60000);
  r = tick(r, 35 * 60000);
  r = advanceToStage(r, 'stage5-branch', 35 * 60000);
  r = chooseBranch(r, 'stage6a-paced-stable', 35 * 60000);

  assert.equal(r.state.pacer.captured, true);
  assert.equal(r.state.pacer.mode, 'VVI');
  assert.equal(r.state.pacer.rate, 70);
  // paced rate (70) exceeds the intrinsic complete-heart-block rate (38) -
  // not demand-inhibited, so the effective rhythm/HR both reflect pacing.
  assert.equal(getEffectiveRhythm(r.state), 'Paced (VVI)');
  assert.equal(getEffectiveHR(r.state), 70);
  assert.equal(r.state.bp.map, 80);
});

test('branch: pacing delayed -> hemodynamics deteriorate further, rhythm stays complete heart block (not paced)', () => {
  let r = createGraphRunner(scenario);
  r = advanceToStage(r, 'stage2-first-degree', 0);
  r = tick(r, 10 * 60000); r = checkAutoAdvance(r, 15 * 60000);
  r = tick(r, 25 * 60000); r = checkAutoAdvance(r, 30 * 60000);
  r = tick(r, 35 * 60000);
  r = advanceToStage(r, 'stage5-branch', 35 * 60000);
  r = chooseBranch(r, 'stage6b-decompensation', 35 * 60000);
  r = tick(r, 39 * 60000); // 4-minute ramp settles

  assert.equal(getEffectiveRhythm(r.state), 'Third-Degree AV Block'); // pacer never captured
  assert.equal(r.state.bp.sbp, 70);
  assert.equal(r.state.bp.dbp, 40);
  assert.equal(r.state.bp.map, 50);
});
