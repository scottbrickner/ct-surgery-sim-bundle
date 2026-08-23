// Structural validation for schema v2 scenario JSON (see schema-v2.md).
// Deliberately hand-rolled rather than a JSON-Schema library dependency -
// matches every other module in this repo (engine/, sync/): zero
// dependencies, plain node --test. Checks STRUCTURE and cross-references
// (dangling stage ids, duplicate ids, required-field presence) - it does
// NOT validate individual physiology field names inside `target`/`set`
// patches (e.g. that "hr" is spelled right); that's rampState()'s job at
// runtime via NUMERIC_PATHS, already covered by engine/physiology.test.js.
// Keeping this validator's scope to structure means it never goes stale
// against the physiology field list.

const KNOWN_TYPES = new Set([
  'baseline', 'deterioration', 'critical', 'arrest', 'intervention-response',
  'rosc', 'branch', 'discussion', 'custom',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a schema-v2 scenario object. Returns { valid, errors }, where
 * `errors` is an array of { path, message } - `path` is a JSON-pointer-style
 * string (e.g. "stages[2].destinationIfUnaddressed") pointing at exactly
 * where the problem is, never a bare "invalid scenario". Non-throwing -
 * always returns a result object, even for a completely malformed/non-object
 * input, so callers (the Builder's import flow) can always render a report.
 */
export function validateScenarioV2(scenario) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isPlainObject(scenario)) {
    return { valid: false, errors: [{ path: '', message: 'Top level must be a JSON object.' }] };
  }

  if (typeof scenario.schemaVersion !== 'string') err('schemaVersion', 'Missing or non-string "schemaVersion" (expected e.g. "2.0.0").');
  if (typeof scenario.id !== 'string' || !scenario.id) err('id', 'Missing or empty "id".');
  if (typeof scenario.title !== 'string' || !scenario.title) err('title', 'Missing or empty "title".');
  if (scenario.baseline !== undefined && !isPlainObject(scenario.baseline)) err('baseline', '"baseline" must be an object if present.');
  if (!Array.isArray(scenario.stages)) {
    err('stages', 'Missing "stages" array.');
    return { valid: false, errors };
  }
  if (scenario.stages.length === 0) err('stages', 'A scenario needs at least one stage.');

  const ids = new Set();
  const idCounts = {};
  scenario.stages.forEach((stage, i) => {
    const path = `stages[${i}]`;
    if (!isPlainObject(stage)) { err(path, 'Each stage must be an object.'); return; }
    if (typeof stage.id !== 'string' || !stage.id) {
      err(`${path}.id`, 'Missing or empty stage "id".');
    } else {
      idCounts[stage.id] = (idCounts[stage.id] || 0) + 1;
      ids.add(stage.id);
    }
    if (typeof stage.type !== 'string') {
      err(`${path}.type`, 'Missing stage "type".');
    } else if (!KNOWN_TYPES.has(stage.type)) {
      err(`${path}.type`, `Unknown stage type "${stage.type}" - expected one of: ${[...KNOWN_TYPES].join(', ')}.`);
    }
    if (stage.target !== undefined) {
      if (!isPlainObject(stage.target)) err(`${path}.target`, '"target" must be an object.');
      if (typeof stage.transitionDuration !== 'number' || stage.transitionDuration < 0) {
        err(`${path}.transitionDuration`, 'A stage with "target" needs a non-negative numeric "transitionDuration" (minutes).');
      }
    }
    if (stage.set !== undefined && !isPlainObject(stage.set)) err(`${path}.set`, '"set" must be an object.');
    if (stage.holdDuration !== undefined) {
      if (typeof stage.holdDuration !== 'number' || stage.holdDuration < 0) err(`${path}.holdDuration`, '"holdDuration" must be a non-negative number (minutes).');
      if (typeof stage.destinationIfUnaddressed !== 'string' || !stage.destinationIfUnaddressed) {
        err(`${path}.destinationIfUnaddressed`, 'A stage with "holdDuration" must also set "destinationIfUnaddressed" (which stage to advance to).');
      }
    }
    if (stage.advanceMode !== undefined && !['auto', 'manual', 'confirm'].includes(stage.advanceMode)) {
      err(`${path}.advanceMode`, `"advanceMode" must be 'auto', 'manual', or 'confirm' if present, got "${stage.advanceMode}".`);
    }
    if (stage.type === 'branch') {
      if (!Array.isArray(stage.branches) || stage.branches.length === 0) {
        err(`${path}.branches`, 'A "branch" stage needs a non-empty "branches" array.');
      } else {
        stage.branches.forEach((b, bi) => {
          const bpath = `${path}.branches[${bi}]`;
          if (!isPlainObject(b)) { err(bpath, 'Each branch must be an object.'); return; }
          if (typeof b.label !== 'string' || !b.label) err(`${bpath}.label`, 'Missing branch "label".');
          if (typeof b.destinationId !== 'string' || !b.destinationId) err(`${bpath}.destinationId`, 'Missing branch "destinationId".');
        });
      }
    }
    if (stage.type === 'discussion' && typeof stage.prompt !== 'string') {
      err(`${path}.prompt`, 'A "discussion" stage should have a "prompt" string.');
    }
  });

  // Duplicate id check, reported once per offending id (not once per occurrence).
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) err('stages', `Stage id "${id}" is used ${count} times - stage ids must be unique.`);
  }

  // Dangling-reference check, now that we know the full set of valid ids.
  scenario.stages.forEach((stage, i) => {
    if (!isPlainObject(stage)) return;
    const path = `stages[${i}]`;
    if (typeof stage.destinationIfUnaddressed === 'string' && stage.destinationIfUnaddressed && !ids.has(stage.destinationIfUnaddressed)) {
      err(`${path}.destinationIfUnaddressed`, `References unknown stage id "${stage.destinationIfUnaddressed}".`);
    }
    if (typeof stage.destinationOnIntervention === 'string' && stage.destinationOnIntervention && !ids.has(stage.destinationOnIntervention)) {
      err(`${path}.destinationOnIntervention`, `References unknown stage id "${stage.destinationOnIntervention}".`);
    }
    if (Array.isArray(stage.branches)) {
      stage.branches.forEach((b, bi) => {
        if (isPlainObject(b) && typeof b.destinationId === 'string' && b.destinationId && !ids.has(b.destinationId)) {
          err(`${path}.branches[${bi}].destinationId`, `References unknown stage id "${b.destinationId}".`);
        }
      });
    }
  });

  if (scenario.startStageId !== undefined && (typeof scenario.startStageId !== 'string' || !ids.has(scenario.startStageId))) {
    err('startStageId', `"startStageId" must reference a real stage id (got ${JSON.stringify(scenario.startStageId)}).`);
  }

  return { valid: errors.length === 0, errors };
}

/** Render a validation result as plain-text lines, for a quick console/CLI report. One line per error, "path: message" (or just "message" if path is empty). */
export function formatValidationErrors(result) {
  return result.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
}
