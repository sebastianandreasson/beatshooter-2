# Beatshooter 2 implementation plan

Status: **M0–M6 implemented and automated acceptance passed. Human audio-latency sign-off remains.**
Prepared 2026-10-20 against `@dylanebert/shallot@0.10.0`.

The application now pins `@dylanebert/shallot@0.10.1-next.2` and uses its native
vignette during active gameplay only. Chromatic section accents retain the
existing shader because this prerelease does not include native chromatic
aberration. Historical engine references below describe the original baseline.

Follow-up experiment: local Beat This! analysis is now implemented and tested
on the four private tracks in `local-audio/`. It is separate from the original
M0–M6 scope. See [prototype results](docs/beat-this-prototype.md) for measured
performance, exact parity with the original model, and pending listening review.

Follow-up implementation: [music synchronized arena and combat effects](docs/music-visuals-plan.md)
now includes the floor shader, musical particles, shared timing, comfort controls
and optional local energy curves. Automated browser checks, the 60 FPS stress
fixture and all four local-track energy checks pass. Human listening/comfort
review remains open; see the
[visual verification record](docs/music-visuals-verification.md).
The original M0–M6 acceptance below remains historical evidence for that scope.

Follow-up neon presentation: ships and enemies now use luminous geometric
outlines, with thin emissive arena rails and brighter projectile, XP and
particle cores. Selective HDR bloom preserves the original sharp scene under
its glow. Musical pulses gently vary bloom; detected section transitions add
a bounded color fringe at the screen edges. A mild vignette frames the arena
while the DOM HUD stays sharp. Fixed pools provide short projectile trails
timed to the local beat, prioritizing nearby hostile shots when crowded.
Pause holds their presentation, and retries clear old trail births. Calm,
Off, reduced motion and reduced flashes control the decoration; Low graphics
reduces bloom resolution/passes and visible trails. See
[neon visual verification](docs/neon-visuals-verification.md).

Follow-up section effects: authored sections and validated LinkSeg spans drive cosmetic changes
across the arena floor. Standard effects send a single shockwave from the map
center outward. Floor and grid colors switch behind its advancing front;
perimeter and background colors blend to the new section's dark palette.
The seven label colors provide preferred themes. A deterministic per-section
choice substitutes a contrasting dark palette whenever the preferred hue
repeats or is too similar to the previous actual palette; adjacent sections
always differ, even when their labels repeat. The front raises nearby
vertices into a smooth travelling ridge across the floor, walls, actors,
shots and particles. Health bars and damage numbers follow the displaced
visuals. Physical transforms and camera orientation stay stable, with normal
player follow intact. Player/enemy/projectile motion stays under gameplay control. Combat
timing, movement, directional dashes, pointer aiming and collision rules keep
their original behavior.

A starfield travels steadily outward behind the arena on the music clock,
using a fixed pool of 960 small, bright stars across three depth planes (480
visible with Low graphics). Baseline travel is five times the original speed.
During each eligible shockwave, speed smoothly rises to 25× that new baseline
(125× the original speed) and settles back while stars stretch into long
hyperspeed streaks. Analytically integrated distance retains all
travel from completed boosts, preventing a backward jump when speed settles.
Pause and slowdown affect star travel with the song; seeking and retries sample
the same deterministic path. Camera orientation remains unchanged.

Eligible transitions anticipate the boundary with a one-beat center-light
buildup (capped at 0.6 song seconds) and a gentle 5% camera zoom, peaking exactly
at the section start. The zoom settles over the first following beat. A cubic
ease-in-out curve drives the outgoing radius, shared by the palette wipe,
vertex ridge, perimeter timing and projected health/damage anchors. The linear
musical coordinate remains available for continuous integrated star travel.
Camera size is set absolutely before pointer input; pause holds it, and
retry/menu/comfort changes restore the captured base without drift.
Calm lowers zoom to 1%; Off/reduced motion/reduced flashes disable the buildup
and zoom. Gaps and overlapping waves do not invent anticipatory pulses.

Each outgoing wave starts at the exact predicted section boundary on the raw
music clock, independently of visual calibration. Its eligible musical span
now runs at 1.3× speed: the normal four-beat window becomes about 3.08 beats.
Slow-song, section-end and missing-beat limits are applied before acceleration,
so previously eligible fast tracks retain their waves. Base windows under 0.65 song seconds and
boundaries inside detection gaps use a bounded color fade without a travelling ring.
Pause freezes the presentation with the song;
retry/seek sample the current section directly without queuing old transitions.
The first section establishes its palette during count-in without an effect.

Calm uses a subtler ring, lower ridge and weaker starfield boost. Off, reduced flashes and OS
reduced motion keep stars static and use a simple palette fade. The wave and
color wipe reuse the floor material. Subdivided arena geometry is allocated
once, and a shared vertex shader displaces scene meshes without changing
collision shapes or uploading mesh vertices every frame. Stars reuse their fixed pool
without allocating entities or materials at section boundaries. Tracks without
section data, such as the dojo, retain
normal star drift and their existing floor palette; no section boundaries are
synthesized. Adjacent detected spans remain distinct even when their labels
match. Model predictions remain
estimates, and listening/comfort review remains open; see the
[LinkSeg evaluation](docs/section-analysis.md) and
[section-effects verification](docs/section-effects-verification.md).

Follow-up gameplay: **Space dash** uses a ±150 ms window around any authored or
detected beat, once per bar, in the movement direction (aim when stationary).
The chart's next bar resets the charge; early first-beat presses consume that
next bar, and repeated or off-beat input never queues a dash.
It uses the audio clock for input and movement targets, keeps solver collisions,
and clears on restart/track replacement. The larger beat/dash indicator is now
at the bottom center. See [dash verification](docs/dash-verification.md).

Follow-up gameplay: waves now mix chasers, stationary three-way spinners and
approaching aimed-shot rangers. Spinners rotate 30° per accented bar start;
both shooters fire only on authored downbeats after a one-bar spawn grace.
Hostile projectiles use swept player collision, share damage immunity with
contact hits, and have distinct silhouettes and a bounded budget.
See [enemy verification](docs/enemy-types-verification.md).

Follow-up arrivals: each main-beat wave first reserves marked positions.
Narrow beams assemble spinning enemies from zero scale over one authored beat.
Only the following beat adds them to live combat and physics: previews cannot
attack, collide, be hit or show health bars. Pending arrivals count toward the
enemy cap; final beats and detection gaps over 3.05 seconds do not queue them.
Animation follows uncalibrated music position through slowdown and pause.
Comfort settings retain a floor footprint and growth without beams, spin or
vertical travel. See [spawn and pacing verification](docs/spawn-pacing-verification.md).

Follow-up progression: enemies now leave persistent XP gems. Nearby gems
attract to the player, collected XP advances per-run levels with carry-over,
and the HUD/results show progress. Requirements now start at 36 XP and rise by
18 XP per level, a 20% increase; gems remain worth 10 XP.
Level-up particles use the shared musical timeline and comfort controls.
The gem/level foundation is recorded in
[XP verification](docs/experience-verification.md); upgrades now build on it
as described below.

Follow-up combat: per-run player stats now own the 13–17 damage range, critical
stats, named additive/multiplicative modifiers, and damage accounting. Projectiles
capture stats at firing time. Every enemy has a health bar, and every impact
including kills displays damage immediately at rest. The next authored beat
starts the number's pop/rise/fade, which lasts one beat; exact-beat hits start
immediately. Slowdown and pause follow the music clock, with stationary fades
for reduced-motion settings. See the [original damage record](docs/damage-verification.md)
and [upgrade verification](docs/upgrades-verification.md) for the updated timing.

Follow-up upgrades: each new run begins with a full-screen free upgrade choice
while music and gameplay wait. Its instructions explain the later side panel
and number keys. Selecting starts the normal count-in without spending XP.
Every new level then queues a seeded offer of three distinct
cards, stacked vertically on the right during normal play. Music, simulation,
movement, aim and dash continue at full speed. Click or press 1/2/3 to apply a
choice immediately and show the next queued offer. The current offer stays
fixed when later levels are earned. Repeated keys, double clicks and stale
card events cannot spend an extra level. Escape/focus loss use normal pause
and preserve the queue; ending or restarting the run closes the panel.

The initial catalog adds +3 to both damage bounds, +20 maximum/current health,
+2 regeneration per five song seconds, +1 normal projectile (cap 7), a six-shot
main-beat barrage followed by +2 shots per rank (cap 24), +5 percentage points
of critical chance (cap 100%), +0.25× critical damage, and +1 ricochet (cap 5).
Utility upgrades add 25% of the base XP attraction radius per rank (cap 300%)
and 0.6 dash distance per rank (3.6 baseline, cap 7.2). They use the same named
stat modifiers and reset with the run. Each dash snapshots its distance while
keeping the existing beat window, duration and collision behavior. Card copy
colors only effect values: red offense, green health, purple utility.
Upgrades use named per-run stat modifiers and clear on restart. Normal volleys
spread symmetrically around the aim, growing by 12° per added projectile up
to a 60° arc. Barrages fire outward only on actual accented bar starts.
Regeneration waits at least five song seconds between heals and lands on the
next authored beat without accumulating a gap backlog. Ricochets hold at the
impact and launch toward a new enemy at most once per beat; each shot keeps
its original damage, critical result, and bounce allowance.

The explicit stress fixture raises the first XP requirement to 1,000,000 solely
to keep the upgrade panel out of profiling; drops and pickups still run.
The fixture does not change normal progression. Current behavior and catalog
values are also documented in [README.md](README.md); the original selection
checks are recorded in [upgrade verification](docs/upgrades-verification.md),
with the earlier pacing changes in [spawn and pacing verification](docs/spawn-pacing-verification.md).

Follow-up specials: offers now have a 12% chance to include one rare, single-tier
upgrade. Wall Bounce reflects a shot once at the arena boundary, independently
of enemy ricochets. Homing Shots applies limited steering toward enemies ahead.
Regenerative Shield absorbs one hit and recharges over 25 raw song seconds,
with a musical charge outline and HUD countdown. Acquired specials disappear
from the offer pool and reset with the run. See
[special upgrade verification](docs/special-upgrades-verification.md).

## Implementation record — 2026-10-20

The original brief and acceptance criteria below are retained for traceability.
They describe the scope that has now been implemented, rather than unstarted
work. No code, dependencies, credentials, or assets were imported from the old
Beatshooter application.

| Milestone | Implementation | Verification |
| --- | --- | --- |
| M0 | Pinned engine/Bun, starter error handling, lockfile and expanded CI retained | Original startup tests and welcome baseline retained |
| M1 | `arena`, `player`: planar physics, acceleration/damping, walls, camera follow, projected pointer reticle, reset, optional diagnostics | Pure movement tests, real Shallot solver test, browser movement/reset/resize projection |
| M2 | `rhythm`, `tracks`: clock-derived transport, count-in, authored timeline, pause/resume/seek/restart/end, generated metronome, original 72-second demo, gains and visual calibration | Fake-clock lifecycle/drift tests; real Chromium AudioContext/analyser and shipped audio decode tests. Human output-device latency check remains pending |
| M3 | `combat`, `enemies`: beat fire, seeded safe spawns, capped pressure, swept nearest eligible hits, crits/knockback/expiry, contact damage and invulnerability | Deterministic combat tests including tunneling/filtering/one-hit, live browser combat and defeat |
| M4 | `session`, `ui`: health/score/kills/progress, pause, results, retry/menu, adjustable dojo, complete ownership cleanup | Ten consecutive browser retries, frozen pause/focus behavior, local-track completion, demo defeat and full 72-second demo win (6,088 points / 58 kills / 55 health) |
| M5 | Track cards, local import and metronome preview, cancellation/error recovery, validated versioned settings/bests/local metadata | Browser decode/invalid-input/missing-file/cancellation/supersession, reload/corruption/reset; local files remain session-only |
| M6 | Graphite/mint/coral style, distinct ship/enemies, hit flashes/damage numbers, reduced effects/low graphics, original assets, static-host headers and release documentation | 26 browser acceptance checks, 52 unit tests, real-physics integration, type check and build pass. Full renderer/physics stress meets 200-enemy/500-projectile target at 60 FPS on M1 Max; desktop/mobile visual and DPR 2 checks pass |

Score rules are **100 per kill + 2 per survived beat**. Normal play caps enemies
at 100, projectiles at 500, and feedback at 100. Practice's generated timeline
lasts six hours and can be reset. Visual timing offsets only move the displayed
beat: positive milliseconds advance it, negative values delay it; they do not
change audio or combat timing.

See [README.md](README.md) for controls/setup and
[docs/release-smoke.md](docs/release-smoke.md) for measured results and the
remaining human listening sign-off. Automated audio signal/scheduling checks
cannot establish perceived speaker/headphone latency. Deployment remains a
separate task, as specified in M6.

## 1. Remake brief

Build a single-player, top-down music shooter with 3D presentation and movement
on a plane. The player steers and aims while weapons fire on musical beats;
enemies arrive in musical patterns, chase the player, take damage, and die.
A complete session has a beginning, a track or practice mode, a result, and a
clean restart.

This is a new implementation. Use the old repository to understand behavior and
intent, not as a source tree to translate. Do not bring over its React components,
Three.js/Rapier/Miniplex stack, OAuth service, credentials, lockfile, or assets.
Choose new game rules and presentation where the prototype never finished them.

The decisions below are a proposed first playable scope, not claims that these
features already exist. Keep the working starter small until each milestone needs
its next module.

## 2. What the original establishes

Baseline: `../beatshooter`, commit `98bbc76` plus the working tree inspected on
2026-10-20. It contains useful mechanics but fails its current type check and
production build.

| Original evidence | Current behavior | Remake direction |
| --- | --- | --- |
| [Player controls](../beatshooter/src/scenes/gameplay/Player/controls.tsx), [camera](../beatshooter/src/scenes/gameplay/FollowCamera.tsx), [reticule](../beatshooter/src/scenes/gameplay/Player/Reticule.tsx) | WASD forces, pointer aim, following camera; manual firing exists but is disabled | Responsive planar movement, camera-correct aiming, visible reticle; automatic beat firing as the default |
| [Enemies](../beatshooter/src/scenes/gameplay/Enemies.tsx), [movement system](../beatshooter/src/scenes/gameplay/systems/MovementSystem.tsx) | One box enemy, chase behavior, one spawn every fourth synthetic beat | One readable enemy first; deliberate spawn positions, contact damage, bounded population |
| [Projectiles](../beatshooter/src/scenes/gameplay/Projectiles.tsx), [hit system](../beatshooter/src/scenes/gameplay/systems/ProjectileSystem.tsx), [damage](../beatshooter/src/scenes/gameplay/state.tsx) | Projectile lifetime, damage ranges, critical hits, knockback | Fresh projectile simulation with swept hit detection, explicit collision filters, and testable damage rules |
| [Damage feedback](../beatshooter/src/scenes/gameplay/Particles.tsx), [cleanup](../beatshooter/src/scenes/gameplay/systems/AutoDestroySystem.tsx) | Floating damage numbers, dead-enemy removal, timed cleanup | Short-lived hit effects and numbers with predictable ownership and limits |
| [Beat system](../beatshooter/src/scenes/gameplay/systems/BeatSystem.tsx), [scene](../beatshooter/src/scenes/gameplay/index.tsx) | Beat every roughly 60 frames; analysis input unused; `useTrack()` commented out | A music-clock-driven transport, authored beat timelines, practice metronome |
| [Menus](../beatshooter/src/scenes/menu/index.tsx), [track cards](../beatshooter/src/scenes/menu/Tracks.tsx) | Menu, saved-track cover grid, test scene; settings is only a label | Working track selection, dojo, settings, pause, results, retry |
| [Spotify client](../beatshooter/src/common/spotify/index.ts), [OAuth server](../beatshooter/lib/index.js) | Partial login/playback/analysis integration | Local/bundled audio first; no Spotify dependency |
| [Postprocessing](../beatshooter/src/common/Postprocessing.tsx), [skybox](../beatshooter/src/common/Skybox.tsx) | Bloom, vignette, lens dirt, cube-map background | Establish a new visual direction after the combat and timing work |

Player health/death, scores, progression, completed-song results, pause/retry, and
persistent settings are new work: the original does not implement them. The
"Beatlooter" label does not establish a loot or inventory system; those stay out
of the first playable scope.

## 3. Foundation and engine references

The official [quick start][quickstart] was followed with
`bun create shallot@0.10.0 beatshooter-2`, followed by `bun install`.
The current stable release is **0.10.0**, rather than 0.1; all engine links in this
plan target that tag rather than the changing `main` branch.

Already present:

- [x] Official minimal scene and startup/loading/error handling.
- [x] Exact engine version, Bun lockfile, Bun 1.4.3 version declaration.
- [x] Shallot Vite plugin, TypeScript config, Bun preload, and upstream tests.
- [x] Generated GitHub Actions workflow and local setup instructions.

Use the installed public exports and JSDoc to confirm APIs as implementation
progresses. Engine examples demonstrate mechanisms, not ready-made shooter
systems.

| Reference at v0.10.0 | Useful for |
| --- | --- |
| [Minimal scene][minimal] and [its unit test][minimal-test] | Plugins, components, mesh/material setup, camera, CPU-only world stepping |
| [First-person player][player-example] | Sampling input separately from fixed-tick movement, explicit system ordering, camera ownership; write our own top-down controller |
| [Save-and-load game][save-game] | `viewportToWorld`, ray queries, entity cleanup, commands |
| [Physics example][physics-example] | Shallot bodies/shapes, collision events, queries, solver setup |
| [Sound example][sound-example] and [audio API][audio-api] | Clips, `Sound`, `Listener`, playback, `AudioOutput` context/bus; not a rhythm transport |
| [Plain DOM HUD][dom-hud] and [Svelte HUD][svelte-hud] | `runApp` UI integration and cleanup; start with plain DOM |
| [World UI example][world-ui] | In-world text and labels |
| [Particles example][particles-example] | Later GPU effects; unnecessary for basic hit feedback |
| [Persistence example][persistence] | Versioned save data and storage boundaries |
| [Public extras][extras] | Text, sprites, sky, outline, vignette, diagnostics |
| [Project workflow][workflow] | Build/test commands and file conventions |

## 4. Music source decision

The default source will be a bundled, redistributable demo track with known beat
data, plus a generated metronome for development. Add user-selected local audio
with editable BPM/offset after the basic game works.

Spotify is excluded from the proposed implementation. Its current
[Developer Policy, section III](https://developer.spotify.com/policy) prohibits
game integrations. Its
[November 2024 API changes](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
also removed Audio Features and Audio Analysis access for new use cases and
affected development-mode apps—the old prototype depends on those endpoints.
Do not make completion depend on recovering the old integration. A different
music source can be considered later with its own access and timing requirements.

For the first demo, commit a small track manifest and a generated/original or
appropriately licensed audio file, recording its source and license. Do not copy
the music from an engine example merely because its code is open source.

Proposed manifest data:

- Stable track ID, title, artist/credit, audio URL, duration, optional artwork.
- Ordered beat timestamps in seconds, with bar/downbeat information.
- For constant-tempo material: BPM, first-beat offset, beats per bar; generate the
  timestamps once from these values.
- Schema version and source/license information.

BPM and offset are a fallback for steady-tempo music, not automatic analysis.
Variable-tempo music needs explicit timestamps. Automated beat detection is a
separate, later experiment.

## 5. Architecture

### Application and ownership

Use Shallot's ECS and plugins directly. A small app composition wires gameplay,
presentation, input, and audio together. Use world-scoped resources for session
state, tuning, random seed, and transport; avoid mutable module-level game state.

Proposed layout as milestones introduce it:

```text
src/
  app/index.ts           # plugin composition and startup
  session/index.ts       # menu/loading/playing/paused/results lifecycle
  arena/index.ts         # scene, boundaries, spawn positions, camera
  player/index.ts        # sampled input, movement, aim
  rhythm/
    index.ts             # beat events and fixed-tick integration
    timeline.ts          # pure timestamp/beat calculations
    transport.ts         # audio start/pause/resume/seek/stop
  combat/index.ts        # weapons, projectiles, hits, damage, lifetimes
  enemies/index.ts       # spawning and chase behavior
  presentation/index.ts  # meshes, reticle, hit feedback, beat pulses
  tracks/                # manifest validation and track/local-file loading
  ui/                    # DOM menus, HUD, settings, results
  settings/              # versioned local preferences
tests/                   # whole-app checks
public/tracks/           # demo music, manifests, credits
```

Keep pure logic and its `*.test.ts` checks beside the owning module. Split a
plugin only when it has a real independent responsibility. The layout is a
direction, not a request to generate empty files now.

### Simulation and presentation

Use X/Z as the play plane and Y as height, with an overhead camera. This is a
deliberate new coordinate convention; the old game used X/Y.

Start player/enemy movement with Shallot's `StandardPhysicsPlugin`, bodies,
shapes, zero gravity, and motion locks for the play plane. Set collision groups
explicitly. Drive bodies through public physics operations and read their
published `GlobalTransform`; do not fight the solver by overwriting poses each
frame. Camera and cosmetic rotation are presentation concerns.

Sample devices in a setup system, consume game commands in fixed systems, and
use interpolated placement for rendering. Normalize diagonal movement.
Convert pointer coordinates through the active camera with `viewportToWorld`,
intersect the ray with the play plane, and derive aim from the player position.
Keep the last valid aim if the ray has no intersection or its direction is zero.

Introduce components such as `Player`, `Enemy`, `Health`, `Weapon`, `Projectile`,
and `Lifetime` only as their mechanics are implemented. Keep meshes/materials
shared. Explicitly order movement, physics, projectile hits, damage/death, and
cleanup; do not assume registration order resolves dependencies.

Projectile collision must cover the segment from the previous to the next
position every fixed step. Resolve only the nearest eligible hit, ignoring the
shooter and using a documented collision mask. If projectile thickness matters,
use a shape sweep or an equivalent planar collision test. Do not reproduce the
old point-like, position-derived ray calculation.

### Audio transport and beat timing

Shallot 0.10 provides clip playback and a public `AudioOutput` context/bus.
Its `Sound` component does **not** expose the precise seek/playhead interface
needed for a rhythm game. Build a small music transport over Web Audio using
that public integration point; do not import private engine audio internals.
Use Shallot clip playback for ordinary sound effects.

The transport owns its source/gain nodes and their cleanup; Shallot owns its
audio context. Start/resume audio from an explicit user gesture. Schedule music
and metronome sounds against `AudioContext.currentTime`. Track position is
derived from the scheduled start and stored offset, not accumulated frame
deltas. Pausing stores the offset and stops the source; resuming creates and
schedules a new source at that offset.

Beat delivery compares previous/current track positions and emits every crossed
timestamp once, in order. Attach a beat index, bar index, and scheduled time.
Bridge observations into fixed-tick commands with stable ordering so combat
does not depend on a monitor's refresh rate. Tests inject a fake transport clock.
Live audio time is external input; do not claim identical replays without
recording the accepted commands.

Define these cases before combat depends on the transport:

- Beat zero and count-in; no shot before the scheduled start.
- Normal frame gaps: process crossed beats once without dropping or duplicating.
- Pause/resume: music, enemies, projectiles, and scoring pause together.
- Tab hiding, audio suspension, or a long stall: pause and require an explicit
  resume; never release a backlog of shots/spawns.
- Seek/restart: reset the timeline cursor and pending commands, with no old hits.
- End of track: deliver completion once and transition to results.
- Visual/audio offset calibration: document the sign and units; change timing
  presentation without rewriting authored beat data.

The first music milestone must prove this integration in a real browser.

### Session lifecycle

Proposed states: `menu → loading → playing ↔ paused → results`, with dojo as a
practice session. Failed loading returns to a useful menu error. Commands such
as start, pause, retry, and quit go through the session owner.

Starting or leaving a session must clear owned entities, reset timers/score/RNG,
stop music and effects, and release local-file object URLs. Dispose world-owned
listeners/resources on teardown. Treat restart as a first-class behavior, not a
page reload. Persist settings and best results, not live runtime objects.

## 6. Milestones and acceptance criteria

### M0 — Official foundation (complete)

Keep the official minimal scene as the known-good baseline. Dependencies are
installed and the engine is pinned. README documents development, checking,
building, and previewing. Run the generated tests and retain their CI workflow.

No shooter feature is represented as complete by this milestone.

### M1 — A controllable dojo

- Replace the welcome scene with a simple arena, ship, overhead camera, reticle,
  and a small controls overlay.
- Implement WASD movement, acceleration/damping, camera follow, and pointer aim.
- Make a reset command restore the initial position and movement state.
- Keep a development diagnostics toggle, off by default.

**Done when:** movement feels consistent at different display rates, diagonal
movement is not faster, aim stays correct after camera movement and resizing,
and the player stays on the play plane. A fixed-step check covers movement and
reset; a browser check covers pointer/canvas coordinates.

References: [player input][player-example], [pointer projection][save-game],
[physics][physics-example].

### M2 — A trustworthy musical clock

- Implement the transport, manifest/timeline validation, and a practice BPM.
- Add a generated audible metronome and a visible beat/downbeat indicator.
- Play one demo track with authored timestamps; implement start, pause, resume,
  restart, and track completion before adding dependent combat.
- Add master/music/effects gain controls and an adjustable timing offset.

**Done when:** the fake-clock tests cover first beat, multiple crossed beats,
pause, resume, seek, restart, and completion. A full demo track plays without
accumulating drift. Browser inspection verifies audible/visible alignment and
that hiding/resuming the tab creates no event burst. Record the browser/device
used for perceptual timing checks; CPU tests alone cannot prove audible latency.

References: [sound][sound-example], [public audio seam][audio-api].

### M3 — One complete combat encounter

- Fire toward the reticle on each configured beat/subdivision.
- Spawn one enemy archetype at bar boundaries, outside a player safety radius,
  with seeded randomness and a population cap.
- Add pursuit, swept projectile hits, health, critical hits, knockback, expiry,
  and minimal damage feedback.
- Add player contact damage and a short invulnerability window.

The old values—damage 5–15, 10% critical chance at 2× damage, enemy health 20,
projectile speed 25 and lifetime 1 second—are tuning references only. Choose
values for the new scale and keep them in one configuration resource.

**Done when:** a player can destroy enemies and be defeated; one projectile
cannot damage twice; fast shots do not tunnel through targets; collision filters
work; dead entities/effects expire; a fixed seed and injected beat sequence
produce repeatable test outcomes.

References: [physics/query examples][physics-example], [text/sprites][extras].

### M4 — A complete playable session

- Add health UI, score, kill count, track progress, and a clear beat indicator.
- Define initial score rules explicitly; use simple kill/survival scoring first.
  Combo systems and loot can follow after the core loop is enjoyable.
- Finish death, song-completion results, pause, retry, and return-to-menu flows.
- Let dojo run without a track, with an adjustable metronome and easy reset.
- Increase enemy pressure by bars/sections with a hard cap rather than by
  uncontrolled wall-clock accumulation.

**Done when:** menu → track → play → win/death → results → retry/menu works
without reloading. Ten consecutive retries leave no old entities, duplicate
listeners, or overlapping music. Pausing freezes gameplay as well as music.

References: [DOM UI lifecycle][dom-hud], [persistence patterns][persistence].

### M5 — Track selection and useful settings

- Replace the old Spotify cover grid with local manifest cards showing title,
  credit, duration, tempo, and optional artwork.
- Add local-file selection with BPM/first-beat-offset input and an audible
  calibration preview. Keep files local; cancel superseded loads cleanly.
- Handle missing files, decode failures, invalid timelines, and unavailable
  audio output with actionable messages.
- Persist volume, timing offset, graphics preferences, and best results using
  versioned, validated local data.
- Keep file persistence explicit: imported files are session-only initially;
  persist metadata/settings, and ask for file reselection after a reload.

**Done when:** one bundled track and one local file can each complete a session;
invalid input does not crash the app; settings survive reload; reset settings
works even with corrupted stored data.

References: [plain DOM HUD][dom-hud], [save/load schema][persistence].

### M6 — Presentation and release preparation

- Establish a visual style: readable player/enemy silhouettes, clear dangerous
  areas, restrained beat pulses, hit flashes, damage numbers, and a new backdrop.
- Use built-in text, sprites, outline, sky, and vignette where helpful. Do not
  assume the old bloom/lens-dirt stack has a direct engine equivalent; evaluate
  any custom effect after the scene is readable.
- Add particles only after measuring the simple effects. Keep gameplay
  authoritative on the CPU; GPU effects remain cosmetic.
- Set and measure an initial stress target (for example 200 enemies and
  500 projectiles at 60 fps on a named desktop); revise the target from evidence.
- Verify unsupported-WebGPU handling, resize, focus loss, audio permission,
  reload, static asset paths, and production preview.
- Add a static-host configuration preserving Shallot's isolation headers and
  document a release smoke test. Deployment is a later task.

**Done when:** the complete loop passes checks and a manual playthrough in
target browsers; performance measurements name the machine and scene; assets
have credits; setup and controls are documented; no debug overlay is forced on.

References: [world UI][world-ui], [particles][particles-example],
[extras][extras], [upstream workflow][workflow].

## 7. Verification and working order

Use the starter's commands and test tiers:

```sh
bun install --frozen-lockfile
bun check
bun test
bunx playwright install chromium  # once per machine/browser version
bunx playwright test
bun run build
bun run preview
```

Keep pure timeline, damage, score, and state-transition checks fast and local.
Use CPU-only `createApp({ defaults: false, ... })` compositions where possible.
Full renderer/physics integration checks belong in `tests/*.node.ts`, run
explicitly with `bun test ./tests/<name>.node.ts`; those may require the optional
WebGPU host dependency documented by Shallot. Browser checks use `*.e2e.ts`.
Do not mistake a passing unit test for verified audio or GPU presentation.

The generated CI already runs the starter's unit and browser checks across
macOS, Linux, and Windows. As gameplay arrives, add type checking and the
necessary integration checks using the same pinned Bun version and frozen
lockfile. Prefer targeted checks during iteration and the full app path at each
milestone.

Implement M1 through M6 in order. Each milestone ends in an observable behavior
and can be reviewed on its own. If music timing or a Shallot API is uncertain,
resolve it with the smallest runnable experiment before building dependent
features. Do not expand scope into multiplayer, native packaging, automatic
beat analysis, procedural content, or loot before the first complete session.

## 8. Initial choices to revisit through playtesting

- Automatic beat firing is the default inherited idea. Manual on-beat firing
  and rhythm accuracy scoring are alternatives, not additional MVP requirements.
- Overhead perspective and X/Z movement are the starting camera/coordinate
  choices; test readability before committing to an art style.
- Start with one weapon, one enemy, one demo track, and one arena.
- Tune the relationship between beat subdivisions, enemy spawn bars, movement
  speed, and difficulty with real music.
- A generated metronome is sufficient for early work; select and credit the
  first demo track during M2.

[quickstart]: https://github.com/dylanebert/shallot/blob/v0.10.0/README.md
[minimal]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/minimal/src/welcome/index.ts
[minimal-test]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/minimal/src/welcome/welcome.test.ts
[player-example]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/first-person/src/player.ts
[save-game]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/save-and-load/src/game.ts
[physics-example]: https://github.com/dylanebert/shallot/tree/v0.10.0/examples/physics
[sound-example]: https://github.com/dylanebert/shallot/tree/v0.10.0/examples/sound
[audio-api]: https://github.com/dylanebert/shallot/blob/v0.10.0/src/core/audio/index.ts
[dom-hud]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/save-and-load/src/hud.ts
[svelte-hud]: https://github.com/dylanebert/shallot/tree/v0.10.0/examples/hud
[world-ui]: https://github.com/dylanebert/shallot/tree/v0.10.0/examples/world-ui
[particles-example]: https://github.com/dylanebert/shallot/tree/v0.10.0/examples/particles
[persistence]: https://github.com/dylanebert/shallot/blob/v0.10.0/examples/save-and-load/src/save.ts
[extras]: https://github.com/dylanebert/shallot/blob/v0.10.0/src/extras/index.ts
[workflow]: https://github.com/dylanebert/shallot/blob/v0.10.0/src/cli/skill.md
