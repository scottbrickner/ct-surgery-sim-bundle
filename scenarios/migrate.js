// v1 (part/step, schema.md) -> v2 (stage graph, schema-v2.md) migrator.
// Mechanical and lossless per schema-v2.md's mapping table - see
// migrate.test.js for a byte-for-byte content check against the real
// flagship JSON, not just a shape check. Does NOT mutate the input.

/**
 * Best-effort stage `type` for a migrated step, since v1 has no equivalent
 * concept. Heuristic, not authoritative - authors should review types after
 * migrating. See schema-v2.md's migration table for the exact rule.
 */
function inferType(step, previousArrestActive) {
  if (step.type === 'discussion') return 'discussion';
  const setFlags = step.set && step.set.flags;
  if (setFlags && setFlags.arrestActive === true) return 'arrest';
  if (setFlags && setFlags.arrestActive === false && previousArrestActive) return 'rosc';
  if (step.type === 'ramp') return 'deterioration';
  return 'custom';
}

/**
 * Convert one v1 scenario object into a v2 scenario object. Flattens every
 * part's steps into one continuous `stages` array; a part boundary (moving
 * from one part's steps into the next part's `initialState`) becomes an
 * inserted `type:'baseline'` stage that `set`s the new part's full
 * initialState wholesale - v1's "each part restarts fresh" behavior has no
 * native v2 equivalent (v2 stages are a continuous graph), so this makes it
 * an explicit, visible stage instead of silently dropping it.
 */
export function migrateV1ToV2(scenarioV1) {
  const stages = [];
  let previousArrestActive = false;
  let stageIdSeen = new Set();

  function uniqueId(base) {
    let id = base, n = 2;
    while (stageIdSeen.has(id)) { id = `${base}-${n}`; n += 1; }
    stageIdSeen.add(id);
    return id;
  }

  scenarioV1.parts.forEach((part, partIndex) => {
    {
      // Every part - including the first - gets its own explicit baseline
      // stage, not just boundaries after part 0. Without this, a part with
      // zero steps of its own (the real flagship's Part 1: "no engine
      // transition, assessment/orientation only") would contribute NO stage
      // at all, silently making startStageId land on a LATER part's first
      // step instead - the "here's the fresh baseline vitals" moment v1's
      // initialState represents would be lost entirely, not just for part 0
      // but for the general case of a part whose first STEP would otherwise
      // become stages[0] with no baseline stage preceding it.
      stages.push({
        id: uniqueId(`${part.id}-start`),
        label: `${part.title} (start)`,
        type: 'baseline',
        set: part.initialState || {},
        facilitatorNotes: part.teachingFocus || undefined,
      });
    }
    part.steps.forEach((step, stepIndex) => {
      const isLastStepOfPart = stepIndex === part.steps.length - 1;
      const isLastPart = partIndex === scenarioV1.parts.length - 1;
      const nextStepExists = !isLastStepOfPart;
      const nextPartExists = !isLastPart;

      const stage = {
        id: uniqueId(step.id),
        label: step.id,
        type: inferType(step, previousArrestActive),
      };
      if (step.coach) { stage.coach = step.coach; stage.facilitatorNotes = step.coach; }
      if (step.prompt) stage.prompt = step.prompt;
      if (step.note) stage.note = step.note;

      if (step.type === 'ramp') {
        stage.target = step.target;
        stage.transitionDuration = step.durationMinutes || 0;
        if (typeof step.autoAdvanceAfterMinutes === 'number') {
          stage.holdDuration = step.autoAdvanceAfterMinutes;
          // destinationIfUnaddressed = whatever comes next in flattened order,
          // computed below once every stage id is known (forward reference).
          stage._pendingAutoAdvanceToNext = true;
        }
      } else if (step.type === 'instant' || step.type === 'event') {
        stage.set = step.set;
        if (step.set && step.set.flags && step.set.flags.arrestActive === true) previousArrestActive = true;
        if (step.set && step.set.flags && step.set.flags.arrestActive === false) previousArrestActive = false;
      }
      // discussion: no set/target, matches v1 exactly.

      stages.push(stage);
    });
  });

  // Resolve _pendingAutoAdvanceToNext -> destinationIfUnaddressed, now that
  // every stage's final id is known (ids may have been de-duplicated above).
  stages.forEach((stage, i) => {
    if (stage._pendingAutoAdvanceToNext) {
      delete stage._pendingAutoAdvanceToNext;
      if (i + 1 < stages.length) stage.destinationIfUnaddressed = stages[i + 1].id;
    }
  });

  return {
    schemaVersion: '2.0.0',
    id: scenarioV1.id,
    title: scenarioV1.title,
    population: scenarioV1.population || 'unspecified',
    patient: scenarioV1.patient,
    baseline: scenarioV1.parts[0].initialState || {},
    startStageId: stages[0] ? stages[0].id : undefined,
    stages,
  };
}
