import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenarioV2, formatValidationErrors } from './validate.js';

function minimalValid() {
  return {
    schemaVersion: '2.0.0',
    id: 'test-scenario',
    title: 'Test Scenario',
    baseline: { hr: 80 },
    stages: [
      { id: 's1', type: 'baseline', set: { hr: 80 } },
    ],
  };
}

test('a minimal well-formed scenario is valid', () => {
  const result = validateScenarioV2(minimalValid());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('a non-object input fails cleanly with a single top-level error, not a throw', () => {
  assert.doesNotThrow(() => validateScenarioV2(null));
  assert.doesNotThrow(() => validateScenarioV2('not an object'));
  assert.doesNotThrow(() => validateScenarioV2(42));
  const result = validateScenarioV2(null);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
});

test('reports missing required top-level fields by exact path', () => {
  const result = validateScenarioV2({});
  assert.equal(result.valid, false);
  const paths = result.errors.map((e) => e.path);
  assert.ok(paths.includes('schemaVersion'));
  assert.ok(paths.includes('id'));
  assert.ok(paths.includes('title'));
  assert.ok(paths.includes('stages'));
});

test('rejects an empty stages array', () => {
  const s = minimalValid(); s.stages = [];
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages'));
});

test('rejects an unknown stage type with the exact bad value in the message', () => {
  const s = minimalValid(); s.stages[0].type = 'not-a-real-type';
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  const e = result.errors.find((er) => er.path === 'stages[0].type');
  assert.ok(e);
  assert.match(e.message, /not-a-real-type/);
});

test('a stage with "target" requires a numeric transitionDuration', () => {
  const s = minimalValid();
  s.stages[0] = { id: 's1', type: 'deterioration', target: { hr: 140 } };
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].transitionDuration'));
});

test('a stage with holdDuration requires destinationIfUnaddressed', () => {
  const s = minimalValid();
  s.stages[0] = { id: 's1', type: 'deterioration', target: { hr: 140 }, transitionDuration: 5, holdDuration: 3 };
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].destinationIfUnaddressed'));
});

test('destinationIfUnaddressed referencing an unknown stage id is a dangling-reference error', () => {
  const s = minimalValid();
  s.stages[0] = {
    id: 's1', type: 'deterioration', target: { hr: 140 }, transitionDuration: 5,
    holdDuration: 3, destinationIfUnaddressed: 'nope-does-not-exist',
  };
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  const e = result.errors.find((er) => er.path === 'stages[0].destinationIfUnaddressed');
  assert.ok(e);
  assert.match(e.message, /unknown stage id/);
});

test('a valid destinationIfUnaddressed pointing at a real stage id passes', () => {
  const s = minimalValid();
  s.stages = [
    { id: 's1', type: 'deterioration', target: { hr: 140 }, transitionDuration: 5, holdDuration: 3, destinationIfUnaddressed: 's2' },
    { id: 's2', type: 'arrest', set: { rhythm: 'PEA' } },
  ];
  const result = validateScenarioV2(s);
  assert.equal(result.valid, true);
});

test('duplicate stage ids are rejected, reported once regardless of how many times the id repeats', () => {
  const s = minimalValid();
  s.stages = [
    { id: 'dup', type: 'baseline' },
    { id: 'dup', type: 'discussion', prompt: 'x' },
    { id: 'dup', type: 'discussion', prompt: 'y' },
  ];
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  const dupErrors = result.errors.filter((e) => /used 3 times/.test(e.message));
  assert.equal(dupErrors.length, 1);
});

test('a "branch" stage requires a non-empty branches array with label + destinationId, all references valid', () => {
  const s = minimalValid();
  s.stages = [
    { id: 's1', type: 'branch' }, // missing branches entirely
  ];
  let result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].branches'));

  s.stages = [
    { id: 's1', type: 'branch', branches: [{ label: 'Go to s2' }] }, // missing destinationId
    { id: 's2', type: 'discussion', prompt: 'x' },
  ];
  result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].branches[0].destinationId'));

  s.stages = [
    { id: 's1', type: 'branch', branches: [{ label: 'Go nowhere', destinationId: 'ghost' }] },
  ];
  result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].branches[0].destinationId' && /unknown stage id/.test(e.message)));

  s.stages = [
    { id: 's1', type: 'branch', branches: [{ label: 'Go to s2', destinationId: 's2' }] },
    { id: 's2', type: 'discussion', prompt: 'x' },
  ];
  result = validateScenarioV2(s);
  assert.equal(result.valid, true);
});

test('advanceMode, if present, must be one of the three known values', () => {
  const s = minimalValid();
  s.stages[0].advanceMode = 'whenever-i-feel-like-it';
  const result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'stages[0].advanceMode'));
});

test('startStageId, if present, must reference a real stage id', () => {
  const s = minimalValid();
  s.startStageId = 'nonexistent';
  let result = validateScenarioV2(s);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'startStageId'));

  s.startStageId = 's1';
  result = validateScenarioV2(s);
  assert.equal(result.valid, true);
});

test('formatValidationErrors renders "path: message" lines, or just "message" for a pathless error', () => {
  const result = { errors: [{ path: 'stages[0].type', message: 'bad type' }, { path: '', message: 'top-level problem' }] };
  assert.deepEqual(formatValidationErrors(result), ['stages[0].type: bad type', 'top-level problem']);
});
