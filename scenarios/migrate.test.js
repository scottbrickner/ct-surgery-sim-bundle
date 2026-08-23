import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrateV1ToV2 } from './migrate.js';
import { validateScenarioV2 } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flagshipV1 = JSON.parse(readFileSync(join(__dirname, 'ct-surgery-flagship.json'), 'utf8'));

test('migrateV1ToV2 does not mutate its input', () => {
  const before = JSON.stringify(flagshipV1);
  migrateV1ToV2(flagshipV1);
  assert.equal(JSON.stringify(flagshipV1), before);
});

test('migrated top-level fields carry over correctly', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  assert.equal(v2.schemaVersion, '2.0.0');
  assert.equal(v2.id, flagshipV1.id);
  assert.equal(v2.title, flagshipV1.title);
  assert.deepEqual(v2.patient, flagshipV1.patient);
  assert.deepEqual(v2.baseline, flagshipV1.parts[0].initialState);
  assert.equal(v2.startStageId, v2.stages[0].id);
});

test('the real flagship scenario migrates to a structurally valid v2 scenario', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const result = validateScenarioV2(v2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('flattens all 3 parts\' steps into one continuous stages array, in order, with an inserted baseline stage for EVERY part (including the first)', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const part1Steps = flagshipV1.parts[0].steps.length; // 0
  const part2Steps = flagshipV1.parts[1].steps.length; // 5
  const part3Steps = flagshipV1.parts[2].steps.length; // 4
  // +1 inserted baseline stage per part, all 3 parts (not just boundaries after the first)
  assert.equal(v2.stages.length, part1Steps + part2Steps + part3Steps + 3);

  const ids = v2.stages.map((s) => s.id);
  assert.ok(ids.includes('part1-bedside-settlein-start'));
  assert.ok(ids.includes('part2-tamponade-arrest-start'));
  assert.ok(ids.includes('part3-ecmo-cannulation-start'));
  // Original step ids preserved verbatim (no renaming needed since none collided)
  assert.ok(ids.includes('tamponade-onset'));
  assert.ok(ids.includes('arrest'));
  assert.ok(ids.includes('ecmo-cannulated'));
});

test('Part 1 (which has zero steps of its own in the source) still contributes its own baseline stage, and startStageId points at it - not silently skipped to Part 2', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  assert.equal(v2.stages[0].id, 'part1-bedside-settlein-start');
  assert.equal(v2.startStageId, 'part1-bedside-settlein-start');
  assert.deepEqual(v2.stages[0].set, flagshipV1.parts[0].initialState);
});

test('a ramp step\'s target/durationMinutes map to target/transitionDuration exactly', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const rampStep = flagshipV1.parts[1].steps.find((s) => s.id === 'tamponade-onset');
  const rampStage = v2.stages.find((s) => s.id === 'tamponade-onset');
  assert.deepEqual(rampStage.target, rampStep.target);
  assert.equal(rampStage.transitionDuration, rampStep.durationMinutes);
});

test('a ramp step\'s autoAdvanceAfterMinutes maps to holdDuration + destinationIfUnaddressed pointing at the very next flattened stage', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const rampStage = v2.stages.find((s) => s.id === 'tamponade-onset');
  assert.equal(rampStage.holdDuration, 3); // matches the authored autoAdvanceAfterMinutes:3
  const idx = v2.stages.findIndex((s) => s.id === 'tamponade-onset');
  assert.equal(rampStage.destinationIfUnaddressed, v2.stages[idx + 1].id);
  assert.equal(v2.stages[idx + 1].id, 'arrest'); // the actual next authored step
});

test('an instant/event step\'s set patch carries over verbatim', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const arrestStep = flagshipV1.parts[1].steps.find((s) => s.id === 'arrest');
  const arrestStage = v2.stages.find((s) => s.id === 'arrest');
  assert.deepEqual(arrestStage.set, arrestStep.set);
});

test('the arrest step is heuristically typed "arrest" (its set includes flags.arrestActive:true)', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const arrestStage = v2.stages.find((s) => s.id === 'arrest');
  assert.equal(arrestStage.type, 'arrest');
});

test('a discussion step migrates with type "discussion" and its prompt/note intact, no set/target', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const discussionStep = flagshipV1.parts[2].steps.find((s) => s.type === 'discussion');
  const discussionStage = v2.stages.find((s) => s.id === discussionStep.id);
  assert.equal(discussionStage.type, 'discussion');
  assert.equal(discussionStage.prompt, discussionStep.prompt);
  if (discussionStep.note) assert.equal(discussionStage.note, discussionStep.note);
  assert.equal(discussionStage.set, undefined);
  assert.equal(discussionStage.target, undefined);
});

test('a step\'s coach text carries to both facilitatorNotes (v2 name) and coach (v1-compat alias)', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const rampStep = flagshipV1.parts[1].steps.find((s) => s.id === 'tamponade-onset');
  const rampStage = v2.stages.find((s) => s.id === 'tamponade-onset');
  assert.equal(rampStage.facilitatorNotes, rampStep.coach);
  assert.equal(rampStage.coach, rampStep.coach);
});

test('an inserted part-boundary baseline stage sets that part\'s full initialState wholesale', () => {
  const v2 = migrateV1ToV2(flagshipV1);
  const boundaryStage = v2.stages.find((s) => s.id === 'part2-tamponade-arrest-start');
  assert.equal(boundaryStage.type, 'baseline');
  assert.deepEqual(boundaryStage.set, flagshipV1.parts[1].initialState);
});

test('re-migrating twice is deterministic (same input -> same output, modulo nothing time-dependent)', () => {
  const v2a = migrateV1ToV2(flagshipV1);
  const v2b = migrateV1ToV2(flagshipV1);
  assert.deepEqual(v2a, v2b);
});
