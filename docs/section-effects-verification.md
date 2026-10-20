# Section-driven arena shockwaves

Implemented against Shallot 0.10.0 using Bun 1.4.3.

## Presentation

Every detected section boundary sends one shockwave from the map center toward
its edges. The floor and grid switch to the new section's colors as the front
passes, leaving that palette behind the ring. Perimeter and background colors
blend to the same theme. Hues match the track timeline: blue intro, green verse,
gold chorus, violet bridge, cyan instrumental, rose outro and slate silence.
Materials stay dark and retain the player/projectile colors.

Stars travel steadily outward behind the arena across three depth planes.
An eligible shockwave smoothly boosts their speed from 1× to 15× and back to
1×, with elongated hyperspeed streaks at higher speeds. Distance accumulates
continuously through the boost and retains the extra travel afterward, so
settling to normal speed does not move the stars backward. The starfield never
changes the camera's orientation or zoom.

The transition normally spans four actual beats, interpolating their timestamps
instead of using average BPM. It starts at the exact detected section timestamp,
including off-beat boundaries. Slow tempos use fewer beats to keep the wave
within 3.5 song seconds. A following boundary or chart gap completes the current
transition; fragments shorter than 0.65 song seconds and boundaries inside
missing timing use a short palette fade. Adjacent spans with the same label
still produce distinct waves, preserving the detector's raw boundaries.

The raw music playhead drives the ring, color wipe and starfield. Pause and
upgrade slowdown hold or stretch the same transition, calibration does not
move section boundaries, and seeking does not create an event backlog. The first section
establishes its colors during count-in without an entrance animation. Missing
analysis preserves the original floor palette and allows normal star drift
without a boost. Menu/results restore the floor palette.

Map geometry, walls and camera poses stay steady during the effect. Normal
player follow continues, and player/enemy/projectile motion stays under gameplay
control. Physics, WASD, dash directions and pointer aiming retain their original
behavior. Calm uses a subtler ring and weaker starfield boost; Off, reduced
flashes and OS reduced motion keep the stars static and use a simple palette
fade without a travelling front.

## Ownership and rendering cost

- `src/section-effects/state.ts`: pure validated timeline, duration bounds and palettes.
- `src/section-effects/index.ts`: music sampling and section presentation state.
- `src/music-visuals/floor.ts`: outward ring, spatial color wipe and fallback palette.
- `src/starfield/motion.ts`: analytic integration of the musical boost envelope and continuous travel.
- `src/starfield/index.ts`: fixed star pool, three depth planes, streak presentation and comfort settings.

The shockwave reuses the existing floor shader and its material. The starfield
creates a fixed pool of 240 nonphysical stars once and updates retained poses
and streak lengths. Low graphics shows 120 stars from the same pool.
No mesh entities, materials, textures or GPU pipelines are allocated at section
boundaries. Shader failure preserves the original floor with palette fades.
A track with no sections avoids building a duplicate musical timeline while
retaining baseline star motion.

Star travel is integrated analytically over the actual beat intervals in each
accepted section transition. Cached segment totals make position sampling a
binary search, independent of frame rate and previous samples. Short spans or
missing beat intervals that only fade the floor palette do not trigger a boost.

## Verification

- `bun test`: 279 tests passed, 28,823 assertions across 37 files.
- `bun check`: no type errors in 341 files.
- Production build passed with the existing bundle-size advisory.
- Three section/starfield browser scenarios passed: the shockwave with
  hyperspeed stars, Off and reduced motion. Two local-file completion/retry and
  invalid-import recovery scenarios also passed. The two
  import tests now open the current Timing → Manual BPM controls.

Pure tests exercise the actual shader helper: only one connected front, new
colors behind it, old colors ahead of it, visible departure from the center,
and no radius wrap. Other checks cover exact off-beat boundaries, variable tempo,
short spans, missing detections, raw-clock sampling, pause, calibration,
comfort settings, stable camera/map/actor poses, and no new entities across
section changes or restarts. Starfield tests additionally verify continuous
integrated distance at irregular beats, settled speed, deterministic seeking,
invisible recycling, safe depth placement, the fixed pool, low graphics,
normal drift without sections, and pause/retry behavior.

The section browser fixture imports a decoded WAV through the normal flow,
replacing only its inference worker with deterministic section/beat output.
Playback, validation, controls, physics and GPU rendering stay real.
Read-only frame samples verify monotonically increasing wave radius, stationary
map/camera orientation, normal movement and aiming, frozen progress on pause,
and persistent colors after completion. They also verify normal star drift,
peak acceleration, continuous travel after the boost, static comfort modes
and stable pool size. The rendered normal stars and hyperspeed transition
were inspected in `output/playwright/section-starfield-drift.png` and
`output/playwright/section-starfield-hyperspeed.png`.
The normal bar ripple is suppressed during the transition.

A separate browser run imported the actual private `Magna Divide.mp3` and ran
both local models. Its first boundary at 4.1912 seconds produced one outward wave
ending at 6.4112 seconds; map and camera transforms stayed unchanged throughout.
The dense combat fixture reached 200 enemies and 488 observed projectiles after
collisions, alongside all 240 stars. Star speed reached 15× and returned to 1×
with continuously increasing distance. Across 134 transition frames, average presentation was 60.00 FPS,
with 16.67 ms 95th-percentile and maximum intervals and no page errors. This is
a 2.22-second transition measurement on this machine, not a whole-track benchmark.
See [the raw live-check record](section-effects-live-check.json).
