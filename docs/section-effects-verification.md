# Section-driven arena shockwaves

Implemented against Shallot 0.10.0 using Bun 1.4.3.

## Presentation

Every authored or detected section boundary sends one shockwave from the map center toward
its edges. The floor and grid switch to the new section's colors as the front
passes, leaving that palette behind the ring. Perimeter and background colors
blend to the same theme. Preferred hues follow the track timeline: blue intro, green verse,
gold chorus, violet bridge, cyan instrumental, rose outro and slate silence.
Materials stay dark and retain the player/projectile colors.
Adjacent palettes are chosen once per timeline. If a preferred hue repeats or
is too close to the previous actual palette, the most contrasting existing
dark palette is substituted. The next transition starts from that chosen
palette. Repeated labels therefore always change color, without random changes
on pause, seek or retry; section labels themselves remain unchanged.

Eligible boundaries now have a one-beat anticipation phase, capped at 0.6 song
seconds. A fixed, soft pool of light gathers at the center while the view zooms
in by up to 5% (1% in Calm), peaking at the boundary. The section label and
global palette remain unchanged during the buildup. The zoom and central light
settle over the first following actual beat.

The outward radius uses cubic smoothstep, `p²(3−2p)`, on the transition's musical
progress: slow departure, faster middle, soft finish. The color front, vertex
ridge, perimeter colors and projected actor labels use the same eased radius.
Star travel retains its linear beat coordinate and exact integrated distance.
Gaps, tiny fade-only sections and overlapping transitions suppress the precharge
and its zoom rather than creating abrupt or invented pulses.

The advancing front raises scene vertices in world Y with a smooth, compact
profile: a three-unit half-width and a peak of 1.275 units in Standard or
0.33 units in Calm. The start/end envelope prevents popping. A corrected normal
follows the height gradient. The same function deforms floor, walls, player,
enemies, projectiles, XP gems, spawn beams and particles; DOM health bars and
damage numbers lift their anchors to match. Background stars are excluded.

Small, bright stars travel steadily outward behind the arena across three depth
planes at five times the original baseline speed. An eligible shockwave smoothly
boosts their speed to 25× that new baseline (125× the original speed), then back
to the new baseline. Thin streaks extend up to ten world units at the peak.
Distance accumulates
continuously through the boost and retains the extra travel afterward, so
settling to normal speed does not move the stars backward. The starfield never
changes the camera's orientation. The brief section zoom is sampled separately
from the same raw music clock.

The transition now runs at 1.3× its previous speed, normally spanning
4 / 1.3 actual beats, interpolating timestamps instead of using average BPM.
It starts at the exact section timestamp, including off-beat boundaries.
The existing slow-tempo, following-boundary and chart-gap caps determine an
eligible span before it is accelerated. This preserves waves at fast tempos
whose new duration falls below the old eligibility threshold.
Base windows shorter than 0.65 song seconds and boundaries inside
missing timing use a short palette fade. Adjacent spans with the same label
still produce distinct waves, preserving the detector's raw boundaries.

The raw music playhead drives the ring, vertex lift, color wipe and starfield. Pause
holds the same transition, calibration does not
move section boundaries, and seeking does not create an event backlog. The first section
establishes its colors during count-in without an entrance animation. Missing
analysis preserves the original floor palette and allows normal star drift
without a boost. Menu/results restore the floor palette.

Physical transforms, collision shapes and camera orientation stay steady during the effect. Normal
player follow continues, and player/enemy/projectile motion stays under gameplay
control. Physics, WASD, dash directions and pointer aiming retain their original
behavior. The orthographic lens changes before input sampling, so aim rays and
projected health bars use the same lens as rendering. Its captured base size is
restored on retry, menu, camera replacement and disposal; pause holds the
absolute zoom without accumulating scale. Calm uses a subtler ring, lower ridge and weaker starfield boost; Off, reduced
flashes and OS reduced motion keep the stars static and use a simple palette
fade without a travelling front, precharge or zoom.

## Ownership and rendering cost

- `src/section-effects/state.ts`: pure validated timeline, duration bounds and palettes.
- `src/section-effects/index.ts`: music sampling and section presentation state.
- `src/music-visuals/floor.ts`: outward ring, spatial color wipe and fallback palette.
- `src/shockwave/surface.ts`: shared CPU/GPU height profile and corrected normals.
- `src/shockwave/index.ts`: scene material routing and music-clock uniform updates.
- `src/shockwave/geometry.ts`: subdivided boxes and rendering bounds.
- `src/starfield/motion.ts`: analytic integration of the musical boost envelope and continuous travel.
- `src/starfield/index.ts`: fixed star pool, three depth planes, streak presentation and comfort settings.

The shockwave reuses the existing floor shader and its material. The starfield
creates a fixed pool of 960 nonphysical stars once and updates retained poses
and streak lengths. Low graphics shows 480 stars from the same pool.
No mesh entities, materials, textures or GPU pipelines are allocated at section
boundaries. Shader failure preserves the original floor with palette fades.
A track with no sections avoids building a duplicate musical timeline while
retaining baseline star motion.

The floor has 11,850 vertices and 22,496 triangles, with half-unit cells.
Wall and fallback grid meshes subdivide their long axes at the same spacing.
Geometry is allocated once at startup. Other meshes retain their original
material rows through a vertex-enabled material type, preserving damage tints
and transparency. A shared uniform drives deformation on the GPU; no per-frame
mesh uploads or simulation-transform changes are needed. Rendering bounds
include the maximum lift so crests do not disappear at the viewport edge.

Star travel is integrated analytically over the actual beat intervals in each
accepted section transition. Cached segment totals make position sampling a
binary search, independent of frame rate and previous samples. Short spans or
missing beat intervals that only fade the floor palette do not trigger a boost.

## Verification

### Anticipation, eased travel and zoom update

- Full unit suite: 317 tests passed, 48,530 assertions across 44 files.
- Typecheck: no errors in 357 files; production build passed with the existing
  bundle-size advisory.
- The three Standard/Off/reduced section browser scenarios passed again with
  5% zoom and the 1.3× wave speed.

Palette regressions cover runs of every repeated label, similar neighboring
hues, quiet fades, seeking and replay. Every adjacent target differs visibly
and the following wave starts from the previous actual target. The browser
fixture includes consecutive Chorus sections: it verifies a different
destination palette, unchanged labels, a changed background color, and that
the new palette persists after the wave. Timing checks cover the accelerated
normal, slow, fast, clipped and variable-tempo windows, including continuous
integrated star travel.

The new timeline checks cover pre-boundary label/palette stability, continuous
impact at the boundary, one-beat recovery, changing tempo, slow-song caps,
overlapping sections, missing beats and deterministic resampling. Radius
samples demonstrate a slower start/end and faster middle with one monotonically
outward front. Shader and routing checks keep the center charge bounded and
non-annular, use eased progress for every surface, and suppress it for comfort.

Camera tests verify captured base sizes, replacement/disposal restoration,
pause/calibration holds and world↔viewport round trips. The browser check also
pauses during anticipation, verifies the unchanged current section, aims
through the zoomed lens, moves across the impact, and checks lifted health bars
against their actual projected anchors. It verifies exact recovery, retry/menu
cleanup and no zoom in Off/reduced motion.

The demo's authored 8-second boundary was also captured during normal playback.
The precharge retained the Intro palette, the outgoing sweep used Verse colors,
and the lens returned exactly to size 17. Center light, eased sweep, HUD clarity
and actor readability were visually reviewed in
`output/playwright/section-impact-charge.png` and
`output/playwright/section-impact-sweep.png`; no page errors occurred.

### Earlier shockwave and starfield baseline

- `bun test`: 285 tests passed, 45,806 assertions across 39 files.
- `bun check`: no type errors in 345 files.
- Four real-physics movement/dash tests passed, including wall collisions and planar movement (660 assertions).
- Production build passed with the existing bundle-size advisory.
- Fifteen browser scenarios passed: the raised shockwave with hyperspeed stars,
  Off and reduced motion; damage bars/numbers; enemy spawn beams; XP collection
  and level-up; floor uniforms, particles, comfort controls, shader fallback and
  calibration reset. The three section/starfield scenarios were repeated after
  the density/speed tuning, confirming 960 stars, baseline speed 5, a peak near
  125 and the unchanged pause, reset and comfort behavior.

Pure tests exercise the actual shader helper: only one connected front, new
colors behind it, old colors ahead of it, visible departure from the center,
and no radius wrap. Vertex tests verify a single positive ridge, exact settling,
bounded comfort amplitudes, corrected normals against finite differences,
identical CPU/GPU height sampling and resolution of the production material.
Material tests cover live tint rows, transparency, new spawns, star/custom
exclusions and culling bounds at changing scales. Other checks cover exact off-beat boundaries, variable tempo,
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
physical map/camera orientation, normal movement and aiming, frozen progress on pause,
and persistent colors after completion. They also verify normal star drift,
peak acceleration, continuous travel after the boost, static comfort modes
and stable pool size. The surface witness additionally verifies dense geometry,
positive front height, zero height outside the front and flat geometry after
completion, retry, menu and disabled motion. The rendered normal stars and
raised hyperspeed transition were inspected in
`output/playwright/section-starfield-drift.png` and
`output/playwright/section-shockwave-bulge.png`.
Enemy health bars are also checked against the lifted world anchor and its
actual viewport projection while the wave passes.
The normal bar ripple is suppressed during the transition.

A separate browser run imported the actual private `Magna Divide.mp3` and ran
both local models. Its first boundary at 4.1912 seconds produced one outward wave
ending at 6.4112 seconds; map and camera transforms stayed unchanged throughout.
The dense combat fixture reached 200 enemies and 488 observed projectiles after
collisions, alongside all 960 stars. Star speed reached 125× the original speed
(25× the new baseline) and returned to 5× with continuously increasing distance.
The wave affected 1,113 scene meshes
plus the 11,850-vertex floor, reached 1.275 units of lift and settled to zero.
Across 133 transition frames, average presentation was 60.00 FPS,
with 16.67 ms 95th-percentile and maximum intervals and no page errors. This is
a 2.22-second transition measurement on this machine, not a whole-track benchmark.
See [the raw live-check record](section-effects-live-check.json).
