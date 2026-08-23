# Scenario schema v2 — staged/branching model

Built for the Scenario Builder (`builder/index.html`) and `engine/stageRunner.js`.
**This is additive, not a replacement**: `schema.md` (v1, part/step/linear)
still governs the live flagship scenario, still runs unmodified through
`engine/scenarioRunner.js`, and still drives the Facilitator Console and all
three device shells today. v2 exists alongside it. `scenarios/migrate.js`
converts a v1 file to v2 losslessly (mechanical field renames only, zero
content loss) - see its tests against the real flagship JSON for proof.

**Why a new engine module instead of extending `scenarioRunner.js`**: v1's
navigation is fundamentally index-based (`partIndex`/`stepIndex` into a fixed
array, `computeStateAt()` replays from a part's `initialState` to settle
anywhere). v2 needs arbitrary stage-to-stage branching by id, which an index
can't express safely without risking the live, tested, in-production v1
runner. `engine/stageRunner.js` is a sibling module, not a fork - it directly
imports and reuses every part of `scenarioRunner.js` that's already generic
(`tick`, `checkOverrideReleases`, `setOverrideWithRelease`,
`releaseOverrideNow`, `startGradualRelease`, `getOverrideInfo`,
`isOverridden`, `applyFacilitatorOverride`, `startFacilitatorRamp`,
`getRampProgress`, `getAutoAdvanceCountdown`, `cancelAutoAdvance` - none of
these reference `partIndex`/`stepIndex` at all). Only navigation
(`next`/`prev`/`jumpToPart`/`createRunner`/`computeStateAt`, and
`checkAutoAdvance`'s scripted-index branch) is genuinely v1-specific and
gets a stage-graph-shaped sibling instead.

**What actually runs live today vs. what's authored-only**: everything below
is capturable in the Builder and validated by `scenarios/validate.js`. Time-
based progression (`transitionDuration`, `holdDuration` +
`destinationIfUnaddressed`) and facilitator-driven branch selection
(`type: 'branch'`) are fully engine-enforced by `stageRunner.js` today.
`successCriteria` and `destinationOnIntervention` are captured as authored
data and shown to the facilitator, but NOT auto-evaluated - that needs the
intervention/assessment-tracking engine (a later phase) to know whether a
learner actually did the thing. Don't present these as "the engine checks
this" in any UI copy until that lands.

## Top level

```jsonc
{
  "schemaVersion": "2.0.0",
  "id": "ct-surgery-flagship",
  "title": "...",
  "population": "cardiothoracic-surgery",  // free-text population/case-family tag - NEW in v2, enables multi-population authoring
  "patient": { "name": "...", "age": 64, "sex": "M", "history": ["..."], "procedure": "..." },
  "baseline": { /* partial physiology state, merged via createState() - same shape as v1's initialState */ },
  "startStageId": "stage1-baseline",        // optional, defaults to stages[0].id
  "stages": [ /* Stage[] */ ]
}
```

Unlike v1, there is only ONE baseline for the whole scenario, not one per
part - v2 stages are a continuous graph (a stage's transition is always
relative to wherever the graph currently is), matching the brief's "Stage
I/II/III/arrest" framing as one continuous arc rather than v1's deliberate
per-part resets. If you need v1's "hours pass, fresh vitals" jump, model it
as an `instant`/`event` stage that overwrites the fields that changed,
same as any other discrete transition.

## Stage

```jsonc
{
  "id": "stage2-tamponade",
  "label": "Stage II — Progressive Deterioration",
  "type": "deterioration",   // baseline | deterioration | critical | arrest | intervention-response | rosc | branch | discussion | custom
  "target": { "hr": 135, "bp": { "sbp": 72, "dbp": 58 } },   // ramp target, same NUMERIC_PATHS whitelist as v1 - omit for a non-ramping stage
  "transitionDuration": 5,     // minutes - required if `target` is present
  "set": { "rhythm": "PEA" },  // instant/event patch - for a non-ramping stage, or applied the instant a ramp above finishes
  "holdDuration": 3,           // minutes AFTER the transition settles before auto-advancing - omit for "settle and wait indefinitely"
  "destinationIfUnaddressed": "stage3-arrest",  // stage id - required if holdDuration is set
  "advanceMode": "auto",       // 'auto' (holdDuration auto-fires) | 'manual' (facilitator must advance) | 'confirm' (same as manual, but the UI visibly flags "ready to advance" once holdDuration elapses - no silent auto-fire)
  "successCriteria": [ { "id": "called-sternotomy", "label": "Called for emergent sternotomy" } ],  // AUTHORED ONLY, see note above - not engine-evaluated yet
  "destinationOnIntervention": "stage2b-stabilizing",  // AUTHORED ONLY, same caveat
  "branches": [ { "label": "Learner starts pressors", "destinationId": "stage2b-stabilizing" }, { "label": "No intervention taken", "destinationId": "stage3-arrest" } ],  // only for type:'branch' - facilitator manually picks one, live
  "debriefMarkers": ["recognized-tamponade-physiology"],
  "facilitatorNotes": "...",   // hidden from learners - same role as v1's `coach`; `coach` is accepted as a v1-compat alias
  "learnerFindings": { "chestTube": "no drainage in the last hour" },  // published findings - captured for the future Patient Assessments Monitor (Phase 8), not consumed by anything yet
  "assessmentRevealRules": { "auscultate-heart": "auto" },  // per-finding reveal rule - same forward-compat status as learnerFindings
  "prompt": "...", "note": "..."  // discussion-type stages, identical meaning to v1
}
```

### `type` values

Purely descriptive/organizational (the engine treats most types alike,
mechanically) except `branch`, which changes navigation:

- `baseline`, `deterioration`, `critical`, `arrest`, `intervention-response`,
  `rosc`, `custom` - any stage with a `target` (ramps) or `set` (instant).
  The type is a label for the Builder's UI and debrief, not a distinct code
  path - use whichever reads clearest to a scenario author.
- `branch` - no `target`/`set` of its own. Presents `branches[]` as facilitator
  choices; the graph only proceeds once one is picked (`advanceToStage()`
  with the chosen `destinationId`).
- `discussion` - identical to v1: no state change, `prompt`/`note` only.

### Timing

Same two-phase model as v1's `ramp` + `autoAdvanceAfterMinutes`, renamed for
clarity now that non-ramp stages can also hold-then-advance:
`transitionDuration` (the ramp itself, if any) then `holdDuration` (grace
period after settling, before `destinationIfUnaddressed` fires). A stage
with neither is instant with no auto-advance - facilitator must manually
move on (or it's a `branch`/`discussion` terminal awaiting a choice).

## Validation

`scenarios/validate.js` exports `validateScenarioV2(scenario)` -> `{ valid,
errors }`, `errors` being `{ path, message }[]` with a JSON-pointer-style
`path` (e.g. `stages[2].destinationIfUnaddressed`) for exact, actionable
reporting - never a generic "invalid scenario." Checks: required fields
present, `type` is a known value, every `destinationIfUnaddressed`/
`destinationOnIntervention`/`branches[].destinationId` refers to a real
stage id in the same scenario (no dangling references), `target`/`set`
fields are plain patch objects (deep validation of individual physiology
field names is intentionally NOT done here - that's `rampState`'s job at
runtime, via the existing `NUMERIC_PATHS` whitelist - this validator checks
structure, not clinical field-by-field correctness), stage ids are unique,
`holdDuration` never appears without `destinationIfUnaddressed`.

## Migration from v1

`scenarios/migrate.js` exports `migrateV1ToV2(scenarioV1)`. Mechanical,
lossless field mapping:

| v1 | v2 |
|---|---|
| `parts[].steps[]` (flattened, in order) | `stages[]` |
| `part.initialState` (first part only) | `baseline` |
| a part boundary (`stepIndex: -1` landing) | an inserted `type:'baseline'` stage that `set`s the new part's `initialState` wholesale, so a v1 part-boundary reset survives the flattening even though v2 has no native "reset to a fresh baseline mid-graph" concept |
| `step.durationMinutes` | `stage.transitionDuration` |
| `step.autoAdvanceAfterMinutes` | `stage.holdDuration` + `destinationIfUnaddressed` (computed: the next stage in flattened order) |
| `step.coach` | `stage.facilitatorNotes` (and `coach` is kept too, as the documented v1-compat alias) |
| `step.type` (`instant`/`ramp`/`event`/`discussion`) | `stage.type` (`custom`/`deterioration`/`custom`/`discussion` by default - authors should retype these to something more specific post-migration, the migrator can't know "arrest" from "instant" alone beyond the id/set heuristic it applies) |

The migrator sets `stage.type` to `'arrest'` heuristically when a step's
`set` includes `flags: { arrestActive: true }`, and to `'rosc'` when it sets
`arrestActive: false` after having been true - otherwise it defaults to
`custom`/`deterioration`/`discussion` per the table above. This heuristic is
a convenience, not a guarantee; always review a migrated scenario's stage
types before publishing it.
