# Music synchronized arena and combat effects

Status: implemented and automatically verified, 2026-10-20.
Production browser checks, performance comparison and four-track energy
integration passed. Human listening/comfort review remains open.
The original proposal below was based on the playable game at
`c0a9cb3`, including local Beat This! analysis and Shallot 0.10.0.

## Implementation record

| Area | Implemented behavior |
| --- | --- |
| Shared timing | Pure timestamp sampler supplies beat/bar phases and envelopes. Paused positions hold presentation; generation changes, track changes, backward seeks and calibration edits clear effects. Existing audio/combat timestamps remain authoritative. |
| Arena | Stable floor geometry with antialiased reference grid, quiet warped layer, broad travelling band, downbeat ring, bar-following perimeter highlights and slow mint/teal variation. A spatial mask reduces decoration near the player. Failed shader preflight retains the static arena. |
| Combat presentation | Explicit fixed-step events feed pooled shards and local rings. Damage numbers use musical age; a steady damage tint replaces the independent invulnerability blink. Separate visual seeds leave combat RNG unchanged. |
| Comfort | **Off / Calm / Standard**, independent graphics detail, existing Reduced flashes, and live OS reduced-motion preference. Reduced motion/flashes disable travelling decoration and retain local fades. Menu/loading decoration is static or progress-driven. |
| Energy | Automatic local analysis computes optional smoothed 20 Hz RMS and bass curves from its existing mono PCM. Demo, dojo, manual-BPM and missing/invalid curves use neutral energy. Energy modulates detail rather than beat timing. |

Deaths, enemy removal and scoring stay immediate. A larger death burst starts
at the next usable quarter-beat subdivision only when it is no earlier than
either accepted event time or calibrated visual time, and no more than
**100 ms** ahead of the latter. Otherwise three small shards shrink in place
with immediate feedback; no larger off-grid accent is added.

Decoration currently supports local intervals from 120 ms through 3.05 s and
rejects outliers relative to nearby intervals. Consecutive implausibly close
beats, long gaps and timeline endings fade toward the quiet floor; they do not
generate a replacement tempo. Particle/feedback envelopes also have bounded
song-time lifetimes, so missed frames cannot replay expired bursts.

| Ownership limit | Current cap |
| --- | --- |
| Fixed-step cosmetic event queue | 256; player feedback and kills take priority over lower-value decoration |
| Pending / active bursts | 16 / 32; nearby kills due on the same subdivision merge |
| Visible shards | 256 High / 64 Low; normal death emits 16 High / 8 Low |
| Visible local rings | 8 |
| Damage feedback records | 100; incoming low-priority hits cannot replace player feedback |

The dense production fixture reached these particle caps while holding 60 FPS
on the recorded M1 Max. [Verification notes](music-visuals-verification.md)
record timing scope and remaining listening/comfort review. The proposal
and acceptance criteria below are retained for traceability; wording such as
“add” or “start with” describes the original design sequence.

## Original proposal

Build an arena that feels like a moving circuit beneath the fight: mint lines
breathe, broad ripples cross the floor, perimeter lights travel around the room,
and defeated enemies dissolve into rhythmic shards. Keep the existing dark
palette and strong enemy/player silhouettes. Give the visual richness to
patterns, depth and motion, with restrained changes in brightness.

## Visual direction

| Effect | Appearance | Musical relationship |
| --- | --- | --- |
| Living floor | A stable grid with a faint second layer that bends and flows beneath it | Gentle movement over each beat; broader travel over a bar |
| Downbeat wave | A soft, wide ring expands through the floor | Starts on an accented bar boundary; dissipates over the bar |
| Perimeter lights | Short illuminated segments travel around the walls | Progress follows the actual bar; corners receive small beat accents |
| Longer variation | Grid flow direction or mint/teal balance gradually changes | A smooth transition across a bar, every 4 or 8 counted bars |
| Enemy death | Small angular shards and a thin local floor ring | Immediate removal/confirmation, then a nearby subdivision accent; decay in musical time |
| Critical kill | A distinct shard shape and slightly wider ring | Same schedule, with a size/detail accent instead of a bright flash |
| Shots and spawns | Short muzzle shapes and restrained spawn outlines | Use existing shot beats and actual spawn downbeats |
| Player damage | A steady, readable damaged/invulnerable outline | Immediate state change, with a restrained musical envelope |

The longer variations are visual arrangements based on counted bars. They are
not claims that the model detected a phrase, chorus or drop.

Keep floor geometry, walls, camera and collision/aiming references stable.
Create the apparent motion in the surface shader. Avoid camera shake, repeated
zoom, full-screen distortion, chromatic separation and large white flashes in
the initial design. Ambient decoration stays less prominent than enemies,
projectiles, the player and the reticle. Attenuate floor motion near the player
with a soft spatial mask so the immediate combat area stays quieter.

## One musical clock

Add a pure sampler in `src/rhythm/visual.ts` and a `MusicVisualsPlugin` in
`src/music-visuals/index.ts`. Publish one shared musical frame for shaders,
particles and existing presentation:

- Accepted song position and calibrated visual position.
- Current/next authored beat, phase within that interval, and fractional beat
  coordinate.
- Progress through the actual bar, plus beat and downbeat envelopes.
- Session generation, active/held state, and whether the local interval can
  support interpolation.

Use `Session.visualPosition` for decorative presentation. It already includes
the user's visual timing offset. Use `Session.position` for event timestamps
and scheduling. Sample after `ObserveMusic`; apply presentation after fixed
combat and player presentation, before renderer material preparation.

Between valid adjacent timestamps, calculate phase as
`(visualTime - previousBeat.time) / (nextBeat.time - previousBeat.time)`.
Use actual bar boundaries and `Beat.downbeat`; an inferred boundary with
`beatInBar === 0` is not an accented downbeat. Preserve the chart's explicitly
synthetic bars when the player is using that fallback.

Do not use average BPM to reconstruct an analyzed song, engine elapsed time,
CSS keyframe loops, or accumulated frame deltas as the effect clock. Evaluate
envelopes and particle trajectories directly at the current musical position.
A dropped frame then displays the appropriate current state instead of
starting a late animation from its beginning.

Before the first beat, use only the existing count-in rhythm. Long detection
gaps, implausibly close detections and the end of the timeline need explicit
handling: fade decoration to its quiet baseline, suppress subdivision
accents, and resume at the next usable authored event. Do not stretch a pulse
across a 20-second gap or invent a continuing tempo. Choose and test local
interval heuristics using the known irregular tracks; these are presentation
guards, not a rewrite of the gameplay chart.

Pause/focus loss holds all phases and particle ages. Retry, track replacement,
generation changes and backward seeks clear the effect queue and pool state.
At completion, use retained session positions: the transport is stopped and
its own position resets. Never release accumulated bursts after a stall.

## Enemy deaths and immediate response

Projectiles fire on beats, but travel time means collisions can happen between
beats. The musical contract is: **game state responds immediately; decorative
accents land on the musical grid**.

1. Resolve damage, remove the enemy/body and award score immediately. Show a
   small confirmation at that location without adding a brightness flash.
2. Schedule the decorative shard expansion and floor ring at the next
   sixteenth-note subdivision of a usable beat interval. These subdivisions
   are interpolated visual timing, not additional detected audio events.
3. Start with a maximum visible wait of **100 ms**, subject to listening/playtesting.
   Measure that delay as `targetTime - visualPosition` when accepting the event,
   so calibration cannot silently create a longer wait.
   If no valid subdivision is that close, keep the immediate confirmation and
   gentle dissolve, and omit the larger accent. Do not delay gameplay or
   invent an off-grid explosion.
4. Let the burst expand and shrink over approximately one beat. Use musical
   age for the trajectory, with a bounded fade through detection gaps.

Respect visual calibration without showing a kill before it happened: choose
a target that has not already passed in either accepted event time or the
current visual timeline. Evaluate an existing envelope at its current age;
do not replay its start when settings or frame rate change.

Extend `CombatStep` with explicit cosmetic event records: stable event ID,
kind, position, critical status and simulation timestamp. Bridge them in
`ResolveCombat` to accepted song time and generation. Do not discover new
deaths by polling the capped `combat.effects` array during rendering, where
several fixed steps can have occurred already.

Use a separate deterministic visual seed derived from the session/event ID.
Changing particle counts or quality must never consume the combat RNG or
change damage, spawns, scores or collision behavior. Musical scheduling here
applies to visual flourishes; existing collision sound feedback remains
immediate. Any future decorative sounds must use audio-clock scheduling.

## Rendering approach

Shallot 0.10.0 exposes `materialType`, `materialLayout`, `MaterialPlugin` and
`MaterialAssets.update`. Use a custom floor material with explicit musical
parameters. `extendedMaterial` cannot add the parameters/bindings this needs.
The engine frame-time uniform is not the song clock.
Declare `typegpu@0.12.8` as a direct dependency when importing it in application
shader code; this matches the installed engine's compatible version.

Keep the floor mesh and physics fixed; combine the grid, flow and downbeat
ripple in one material. Replace redundant grid decoration where appropriate,
keeping a stable reference grid and readable boundaries. Use antialiased line
widths and broad patterns to limit distant shimmer. Implement a soft local
halo in the material before considering full-screen bloom.

Start death effects with pooled small mesh or sprite entities, shared
geometry/materials and analytic trajectories. An initial budget to measure:

- 8–16 shards per death; at most 256 visible shards on High and 64 on Low.
- At most 16 pending decorative bursts and 8 visible local rings.
- Merge overlapping rings due on the same subdivision; discard low-priority
  decoration when full. Preserve player feedback and kill confirmation.
- No physics bodies, DOM elements, material allocation or shader compilation
  per particle. Prewarm material pipelines during loading.

These are starting limits, not measured performance guarantees. The official
particle example uses a custom render/compute path rather than a built-in
particle plugin. Adopt a dedicated instanced pass only if the pooled version
fails the measured budget. The public producer-table path does not support
blended/additive materials, so it is not a shortcut for translucent sparks.

Keep effects ownership in `src/music-visuals/`, with focused `floor.ts`,
`particles.ts` and scheduling helpers as needed. Integrate through `src/app/`,
`src/arena/`, `src/session/`, `src/presentation/` and `src/settings/`.
Continue using public engine APIs and the pinned version.

## Intensity and comfort

Ship a restrained Standard preset and an independent effects-intensity control:
**Off / Calm / Standard**. Keep graphics quality separate from artistic
intensity. Low already disables antialiasing and lowers render resolution;
it should also reduce particle counts and shader layers.

Apply the existing Reduced flashes preference to every GPU effect, and read
`prefers-reduced-motion` in the effect system. It currently affects DOM CSS
only. Reduced motion should disable travelling/warping decoration and use
small, steady outlines and fades for gameplay feedback. Validate new settings
with defaults so existing saved preferences continue to load. The browser
exposes the OS preference through the standard
[reduced-motion media query](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

Replace the current fixed 5 Hz player invulnerability blink and move damage
number travel/fade to the shared musical presentation. Immediate health and
score changes stay readable. During play, every recurring decorative motion
must derive from the shared clock; essential input and game response stay
responsive. Menus/loading have no track clock and should use static or
progress-driven decoration.

Do not flash the whole arena on every beat. Fast tracks can exceed three beats
per second; smooth motion alone does not establish that a luminance change is
comfortable. Bound brightness, overlap, visible area and saturated-red changes
across the composite image, not just individual emitters. Review full-screen
captures against the
[W3C flash criteria](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold).
Reduced settings supplement a restrained default; they do not substitute for
checking the default experience.

## Optional energy response

Beat This! supplies beat/downbeat timestamps, not bass strength, loudness or
song-section labels. The first complete version can work from those timestamps.

After its visual timing is convincing, compute inexpensive loudness and
low-frequency energy curves from the already decoded local PCM. Store them at
a modest fixed rate, normalize against the track with a silence floor, smooth
them, and sample them with the same song clock. Reuse the local worker pipeline
and its cancellation/ownership rules.

Energy controls how far a ripple travels or how much detail is present; it
does not trigger extra flashes or establish a second rhythm. Gentle sections
can become quiet and dense sections richer within the same intensity cap.
Dojo uses a neutral envelope. Do not advertise drop detection or make this
additional analysis a prerequisite for basic effects.

## Delivery sequence

| Step | Deliverable | Acceptance |
| --- | --- | --- |
| 1. Shared timing | Musical sampler, envelopes, lifecycle rules and inspection values; replace the free-running damage blink | Variable-tempo and pause/retry tests pass; visuals cannot affect combat |
| 2. Arena prototype | One floor shader with grid breathing, downbeat ripple and perimeter motion; intensity/reduced-motion controls included | Review the demo and all four tracks for alignment, readability and comfort before layering more |
| 3. Combat effects | Explicit event bridge, pooled death shards/rings, shot/spawn accents and musical damage feedback | Events consumed once, immediate gameplay response, bounded queues/pools, no post-pause backlog |
| 4. Full polish | Restrained multi-bar variation, quality scaling, optional energy curves if useful | A full-track review remains comfortable; quiet sections settle; no obscured hazards |
| 5. Release checks | Production regression, stress comparison, screenshots/captures and documented tuning | Timing/lifecycle tests, performance budget and human review pass |

The first reviewable slice should be the floor ripple plus one death burst.
Use it to settle how much motion feels right before expanding the palette.

## Verification and completion

- Pure timing tests: identical musical positions produce identical phases and
  particle positions at simulated 30/60/144 Hz. Cover variable tempo, pickups,
  inferred boundaries, unusual meter, offset sign, count-in/endpoints and long
  gaps. Quantized targets must be valid future subdivisions within the wait cap.
  A visible accent appears on the first rendered frame at/after its calibrated
  target; verify bounded frame latency and no accumulated drift.
  At both ±250 ms calibration extremes, require no pre-kill accent and either
  a valid accent within the visible wait cap or deliberate suppression.
- Event/lifecycle tests: multiple fixed ticks before render, several same-beat
  kills, queue overflow, pause/resume, focus loss, retry, seek and track
  replacement. Verify no duplicate/late bursts or retained entities/resources.
- Combat invariance: all effects settings produce identical simulation results
  and RNG state for the same commands.
- Browser checks: material parameters and particle poses hold on pause;
  effects respect OS reduced motion and saved preferences; shader errors fail
  back to the existing static material; screenshot review at normal and low
  resolution/DPR 2 preserves silhouettes and aiming.
- Re-run the existing unit/browser/build checks and the production
  200-enemy/500-projectile stress fixture with a repeatable worst-case burst
  schedule. Target 60 FPS on the recorded M1 Max baseline and initially budget
  no more than about 2 ms additional rendering work. Measure frame-time tails
  and available CPU/GPU timings; reduce decorative complexity if needed.
- Listen and play through the demo and all four private tracks, including
  breakdowns, busiest combat, fast passages and irregular detections. Review
  full-screen composite flashing, visibility and subjective fatigue. Record
  track/timestamp feedback and final settings.

Completion means a readable, comfortable, music-timed arena and bounded combat
effects with verified lifecycle/performance behavior. It does not require
engine upgrades, a new renderer, full-screen postprocessing or song-section ML.
