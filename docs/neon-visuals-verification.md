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

Section-transition and dense-scene verification are recorded below after their
runtime checks complete.
