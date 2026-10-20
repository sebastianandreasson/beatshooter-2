# Section-driven arena transitions

Implemented against Shallot 0.10.0 using Bun 1.4.3.

## Presentation

Every detected section boundary starts a full 360° tumble of the decorative
floor and grid about the world's Z axis, returning them flat beneath combat.
The section effect keeps the camera's orientation and zoom steady; normal
player follow continues. Three expanding portal frames surround the arena
while radial waves and a spiral grid sweep across its floor. The floor,
perimeter, and background settle into the new
section's palette. Hues match the existing timeline: blue intro, green verse,
gold chorus, violet bridge, cyan instrumental, rose outro, slate silence.
Materials stay dark and retain the player/projectile colors.

The transition normally spans four actual beats, interpolating their timestamps
instead of using average BPM. It starts at the exact detected section timestamp,
including off-beat boundaries. Slow tempos use fewer beats to keep travel within
3.5 song seconds. A following boundary or chart gap ends the current turn;
fragments shorter than 0.65 song seconds and boundaries inside missing timing
use a short palette fade instead. Adjacent spans with the same label still
produce distinct transitions, preserving the detector's raw boundaries.

The raw music playhead drives every channel. Pause and upgrade slowdown hold or
stretch the same transition, calibration does not move section boundaries, and
seeking does not create an event backlog. The first section establishes its
colors during count-in without an entrance animation. Missing analysis leaves
the original arena unchanged. Menu/results restore the floor pose and palette.

The transition leaves physics bodies, the play plane and collision rules
untouched. Players, enemies, projectiles and perimeter walls do not inherit the
decorative floor's rotation. WASD, dash directions and pointer aiming retain their original
behavior. The HUD remains upright. Calm replaces the full floor turn with a
small sway; Off, reduced flashes, and OS reduced motion keep color changes
without travel.
Low graphics retains the broad wave and one portal frame while skipping the
additional spiral-grid detail.

## Ownership and rendering cost

- `src/section-effects/state.ts`: pure validated timeline, duration bounds, and palettes.
- `src/section-effects/index.ts`: music sampling, decorative floor/grid poses, fixed portal pool.
- `src/music-visuals/floor.ts`: section shader uniforms and fallback material colors.

The portal pool contains 12 reusable, nonphysical mesh entities. No meshes,
materials, textures, or GPU pipelines are allocated at section boundaries.
Hidden portals skip material and transform updates. The floor adds fixed-size
uniform data to its existing material; shader failure preserves the original
floor and still supports palette changes. A track with no sections avoids
building a duplicate musical timeline.

## Verification

- `bun test`: 258 tests passed, 21,198 assertions across 33 files.
- `bun test ./tests/player.node.ts`: 4 real-physics checks passed, 660 assertions.
- `bun check`: no type errors in 332 files.
- Production build passed with the existing engine bundle-size advisory.

New pure and integration tests cover irregular tempos, exact off-beat boundaries,
20–300 BPM, repeated labels, short spans, gaps, pause/seek/retry, calibration,
comfort settings, floor settlement, stable camera/actor poses and fixed pool
ownership.

The three browser scenarios import a decoded WAV through the normal analysis
and track-selection flow. A routed module worker supplies deterministic inference
output; playback, validation, physics, rendering, and controls remain real.
Read-only witnesses inspect floor rotation beneath combat, stable camera and
actor poses, ordinary movement and pointer projection, frozen decoration,
restored floor orientation, persistent palettes, and Off/reduced motion.
The mock worker retains the production COEP header.

Screenshot artifacts are `output/playwright/section-floor-tumble.png` and the
comfort variants under `output/playwright/section-map-*.png`.

A second browser run imported the actual private `Magna Divide.mp3`, ran both
local models, and exercised its first detected boundary at 4.1912 seconds.
The floor turn finished at 6.4112 seconds with the camera orientation and size
unchanged in every sampled frame. The existing dense combat fixture reached
200 enemies and 488 observed projectiles after collisions. Across the
134 transition frames, average presentation was 60.00 FPS, with 16.67 ms
95th-percentile and maximum intervals and no page errors. This measures that
2.22-second transition on this machine, rather than a whole-track benchmark.
The raw result is in [the live-check record](section-effects-live-check.json).
