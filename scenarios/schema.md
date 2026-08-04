# Unified scenario schema

This is the ONE schema for scenarios that drive the shared physiology engine
(`engine/physiology.js` + `engine/scenarioRunner.js`). It's new as of Phase 1
and deliberately separate from the pre-existing scenario packs already in
this repo (`devices/pacemaker/pace-scenarios.json`, and the hardcoded CTSCN-4
pack inside `HemoSphere_Alta_Sim.html`/`IntelliVue_Sim_Monitor.html`) - per
`docs/BUILD_PROMPT.md` §8.3, those stay as each device's own secondary/
practice content and are not migrated to this format.

## Top level

```jsonc
{
  "id": "ct-surgery-flagship",
  "title": "...",
  "patient": { "name": "...", "age": 64, "sex": "M", "history": ["..."], "procedure": "..." },
  "parts": [ /* Part[] */ ]
}
```

## Part

A part is a distinct segment of the case with its own starting snapshot -
the source case study restarts each part at a fresh "Start of scenario:"
vitals block rather than carrying the prior part's ending state forward
(hours pass between parts, off-screen). `engine/scenarioRunner.js` enforces
this: crossing into a new part always applies that part's `initialState`,
never the previous part's ending state.

```jsonc
{
  "id": "part2-tamponade-arrest",
  "title": "Scenario 2: Tamponade -> Arrest",
  "teachingFocus": "...",             // optional, facilitator-facing context
  "initialState": { /* partial physiology state, see below */ },
  "steps": [ /* Step[] */ ]
}
```

`initialState` is a *partial* snapshot merged onto the physiology engine's
full default shape via `createState()` - you only need to specify fields
that matter for this part, everything else falls back to sane defaults.

## Step

Every step has `id`, `type`, and an optional `coach` (facilitator-only
narration text, never shown to learners). The `type` determines what else
is required:

- **`instant`** - apply `set` (a partial state patch) immediately, no
  transition. Used for anything that just changes without a visible ramp.
- **`ramp`** - linearly interpolate the numeric fields named in `target`
  from their current value toward `target`'s value, over `durationMinutes`
  of real wall-clock time. Only fields in `engine/physiology.js`'s
  `NUMERIC_PATHS` whitelist may appear in `target` - rhythm, pacer.mode,
  and flags.* are NOT ramp-able (the engine throws if you try); use an
  `event` step for those instead. Optional `autoAdvanceAfterMinutes`: once
  the ramp settles, if the facilitator hasn't already manually navigated
  away, `engine/scenarioRunner.js`'s `checkAutoAdvance()` automatically
  advances to whatever step comes next (typically an `event`) this many
  *additional* real minutes later - e.g. "if nobody addresses it, the
  tamponade progresses to arrest on its own." Omit for a ramp that just
  settles and waits indefinitely for the facilitator, unchanged from
  before this field existed. The facilitator can always head this off:
  `cancelAutoAdvance()` stays on the current step indefinitely, or simply
  navigating manually (`next`/`prev`/`jumpToPart`) cancels it as a side
  effect, same as it clears any other in-flight ramp.
- **`event`** - same mechanics as `instant` (applies `set` immediately) but
  marks a hard, discrete clinical event (arrest, sternotomy, cannulation)
  rather than a routine value change. Kept as its own type so a future UI
  can treat these differently (e.g. a confirmation banner) even though the
  engine itself handles `instant` and `event` identically.
- **`discussion`** - no state change at all. Carries a `prompt` (and
  optionally `note`, the facilitator's own answer/rationale) for teaching
  points that don't correspond to a monitor value - e.g. "IABP vs Impella
  vs ECMO?" in Part 3. Purely for the facilitator console to display.

```jsonc
{ "id": "tamponade-onset", "type": "ramp", "durationMinutes": 5,
  "target": { "hr": 135, "bp": { "sbp": 72, "dbp": 58, "map": 65 }, "pa": { "systolic": 45, "diastolic": 15 }, "cvp": 15 },
  "coach": "Tamponade physiology developing over the next several minutes." }

{ "id": "arrest", "type": "event",
  "set": { "rhythm": "PEA", "hr": 150, "bp": { "sbp": 0, "dbp": 0, "map": 0 }, "pa": { "systolic": 0, "diastolic": 0 }, "cvp": 0, "spo2": 0, "flags": { "arrestActive": true } },
  "coach": "Patient arrests - PEA at 150 on the strip, no pulse. Pulse ox inoperative." }

{ "id": "iabp-vs-impella-vs-ecmo", "type": "discussion",
  "prompt": "What mechanical support options are on the table?",
  "note": "IABP: no, indirect offload only. Impella: maybe, but not bedside-placeable. ECMO: yes if criteria met - bedside, rapid pressor wean." }
```

## Physiology state fields (what `set`/`target`/`initialState` can contain)

See `engine/physiology.js`'s `BASE_STATE` for the authoritative full shape
and default values. Summary:

| Field | Notes |
|---|---|
| `minute`, `hr`, `rhythm` | `rhythm` is the *intrinsic* rhythm - see `getEffectiveRhythm()` for how pacing capture affects what actually displays |
| `bp.{sbp,dbp,map}` | `map` is an **independently authored** field, never derived from sbp/dbp - transcribe it exactly as charted in the source case, even where it doesn't match the textbook `(SBP+2*DBP)/3` formula |
| `pa.{systolic,diastolic}`, `cvp` | pulmonary artery pressure, central venous pressure |
| `co`, `ci`, `svr`, `svri`, `svv`, `ppv`, `scvo2`, `hpi` | HemoSphere Alta-facing hemodynamics |
| `spo2`, `rr`, `temp` | |
| `drips.{epi,levo,milrinone,propofol,fentanyl,vasopressin,insulin}` | native charted units per drug (mcg/min, mcg/kg/min, units/hr - see the case study) |
| `ivpb` | intermittent piggyback name (e.g. `"vancomycin"`), not a rate |
| `chestTubes.{rPleural,rMediastinal,blake,lPleural,lMediastinal}` | charted output in mL |
| `pacer.{mode,rate,outputMa,sensitivityMv,captured}` | `mode`/`captured` are discrete (event-only); `rate`/`outputMa`/`sensitivityMv` are ramp-able |
| `flags.{arrestActive,sternotomyPerformed,ecmoCannulated}` | discrete event flags, event-only |
