# Neon arena presentation

Implemented with Shallot 0.10.0, TypeGPU 0.12.8 and Bun 1.4.3.

## Presentation and timing

Player and enemy cubes retain dark faces with bright, antialiased geometric
edges. Thin emissive rails outline the arena. Projectile cores, XP gems, arrival
rails and death/level-up particles supply distinct mint, coral, blue, violet and
gold highlights. Live damage tints and translucent beams retain their existing
material rows.

The camera's HDR effect stack extracts bright highlights with a soft threshold,
blurs them at reduced resolution, then adds that glow to the original sharp
scene before tone mapping. It avoids raising the entire dark floor into bloom.
A mild vignette frames the scene. During eligible section transitions, a
sinusoidal envelope adds at most 0.75 pixels of radial red/blue separation near
the screen edges; the center remains unaffected. The DOM HUD, damage numbers
and health bars are outside this postprocessing stack.

Bloom uses the shared musical pulse and section envelope. No independent
animation timer or temporal history texture drives it. Projectile trails grow
over 0.12 of the local beat for player shots and 0.14 for hostile shots, with
length caps of two and 1.2 world units respectively. Their tapered geometry sits
behind the projectile core. Pause holds both the sampled envelope and trail
heads; retry, track replacement and rewind clear old trail births. Waiting
ricochets have no trail, and a released bounce starts a new trail.

Calm lowers bloom and color separation and shortens/narrows trails. Off removes
the effect pass and hides trails. Reduced flashes and OS reduced motion retain
a steady, gentle glow and disable trails and color separation. Existing
section-wave and starfield comfort controls remain in force. The pass changes
no camera, physics or gameplay state.

## Ownership and cost

- `src/neon/index.ts` owns effect registration, pipelines, per-camera uniforms,
  render targets and cached bind groups.
- `src/neon/postprocess.ts` owns musical envelopes, target dimensions and the
  extraction/blur/compositing shaders.
- `src/neon/edges.ts` supplies the geometric edge emission used by the existing
  shockwave material, preserving vertex deformation and live material handles.
- `src/neon-trails/` owns a fixed pool of 192 nonphysical tapered meshes with two
  shared translucent materials. Low graphics shows at most 64. Hostile shots
  take priority, then distance to the player.

High graphics uses four GPU passes, extracting at half resolution and blurring
at quarter resolution. Low uses three passes, extracting at quarter resolution
and blurring at eighth resolution. The final composite retains full scene
resolution. Targets and bind groups persist until viewport size or quality
changes; toggling effects and retrying reuse the allocations. Removed cameras
and world disposal release owned buffers/textures. A shader initialization
failure bypasses the pass and retains the playable scene.

## Automated and visual checks

The full unit suite passes: 301 tests and 47,176 assertions across 44 files.
`bun check` reports no errors in 357 files. The production build passes with
the existing engine bundle-size advisory.

New tests cover musical sampling and comfort modes, finite soft-knee
contribution, geometric edge emission, shader resolution, GPU target/group
reuse, quality changes, resize, camera pruning, disposal and fallback. Trail
checks cover geometry, local beat duration, hostile priority, capacity bounds,
pause, bounce, comfort settings and session cleanup.

The three new browser scenarios verify real GPU bloom and combat trails,
exact pause holds, retry reuse, Calm/Off/OS reduced motion, Low resolution/pass
counts, viewport resizing and restoration. Rendered captures show distinct
projectile cores and tails, readable enemy silhouettes and sharp HUD text:

- `output/playwright/neon-combat-glow.png`
- `output/playwright/neon-reduced-motion.png`
- `output/playwright/neon-resize-restored.png`
- `output/playwright/section-shockwave-bulge.png`

All 18 relevant browser scenarios passed: the three new neon scenarios, three
section-wave/starfield scenarios and 12 damage, enemy-arrival, XP and musical
effects regressions. The checks exercise real combat, health-bar projection,
vertex lift, single outward wave progression, frozen pause state, retry/menu
cleanup, disabled motion, calibration and floor-shader fallback. Several older
restart assertions were updated to recognize the new starting-upgrade screen
and wait for playback before aiming or sampling the next wave.

## Real-track dense-scene check

The actual private `Magna Divide.mp3` was imported through the normal local
analysis flow. This run produced 452 beats and 17 sections. The first detected
transition ran from 4.1912 to 6.4112 song seconds. All four bloom passes stayed
active with a 1280×800 scene, 640×400 highlight extraction and 320×200 bloom.
Bloom rose from 0.62 to 0.7625; edge color separation peaked at 0.75 pixels and
returned to zero. Camera and physical map transforms remained stable.

The opt-in dense fixture reached 200 enemies and 490 observed projectiles,
alongside 960 stars and all 192 trail slots. Trail count stayed within its
budget. The shockwave affected 1,306 meshes plus the subdivided floor, reached
1.275 units of lift, and settled flat. Stars reached 125× their original speed
and returned to the current 5× baseline. Returning to the menu removed active
trails and postprocessing passes.

On the Apple M1 Max MacBook Pro (32 GPU cores, 64 GB RAM, macOS 15.7.7),
Chromium 156.0.8078.4 presented 133 transition frames at an average 60.00 FPS,
with 16.67 ms 95th-percentile and maximum frame intervals. This is a short
2.22-second transition check at 1280×800, including a midpoint screenshot,
not a whole-track benchmark or a GPU-only timing measurement.

No page or rendering errors were observed. ONNX emitted its existing CPU
identification/provider-assignment warnings during model setup; these are
retained separately in the report. The live midpoint capture was visually
reviewed for distinct projectile cores/tails, enemy outlines and HUD clarity.
See [the measured record](neon-live-check.json) and
`output/playwright/neon-live-section-midpoint.png`.
