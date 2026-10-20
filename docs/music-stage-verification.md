# Music stage effects

Implemented 2026-10-20 in the existing Shallot 0.10.0 project.

## Behavior

- A 16-band spectrum repeats along the four outer walls. Bass bars are broader;
  treble bars are narrower. Length comes from the measured spectrum.
- Four outward laser fans change formation smoothly over beats. Bass accents
  and spectral transients brighten their soft cores; mids extend the rays.
- Two curling aurora ribbons carry small moving particles. Mids widen the
  ribbons and highs lengthen the particles. Travel now advances with the shared
  beat envelope; changing instantaneous energy cannot move the timeline.
- Three expanding, rotating geometric echoes fade before recycling. They echo
  only the decorative backdrop, never actors, projectiles, or UI.
- Two wireframes morph among square, hexagon, octagon, and dodecagon forms.
  Section changes unfold them with the existing section envelope.
- Section arrangements crossfade over 1.5 seconds. Intro/outro are sparse,
  verses emphasize the spectrum, choruses emphasize lasers and geometry,
  and bridges emphasize auroras. Measured energy still governs intensity.

The 336 meshes and six materials are created once. All are nonphysical.
The original floor depth-occludes the stage; a dedicated material keeps these
background objects out of the arena's shockwave deformation. Soft ribbons,
particles, and lasers use small transparent planes and the existing bloom.
No new full-screen postprocessing targets, assets, or dependencies are needed.

## Audio and lifecycle

`calculateEnergy` retains its loudness/bass normalization and adds a 2048-point
Hann FFT sampled at 20 Hz. Sixteen logarithmic bands span 40–10,000 Hz; mids
cover 250–2,000 Hz and highs cover frequencies above 2,000 Hz. Positive spectral
flux provides a transient envelope. A 0.7-second vs 3.5-second energy envelope
provides buildup/release. All bands share the track's loudness reference.

The new metadata uses 21 bytes plus one float per frame: 500 bytes/second.
It is optional, validated independently, and never changes beat timestamps,
bar assignment, combat, or section inference.

Automatic imports compute it in the existing analysis worker. Bundled and
manual-BPM tracks use a separate DSP-only worker after native mono resampling,
without requesting models. Manual imports reuse visual curves with their
retained decoded buffer. Cancellation terminates the worker and superseded
loads remain rejected; optional DSP failure leaves the track playable.

All poses are sampled from absolute music position. Pause freezes the layer;
seek and retry reconstruct it without stale particles or event queues.
Travel surges over the first 55% of each beat, then holds. Spectrum accents,
laser formations, aurora travel, particles and geometric echoes use that same
timing. Hidden pool slots reset their complete pose, so seeking reconstructs
even invisible geometry deterministically. See the
[beat pulse verification](beat-pulse-verification.md) for the subsequent timing pass.
Calm reduces brightness. Low reduces lasers, ribbon segments, particles, and
wireframe/echo copies. Off hides the stage. Reduced flashes and OS reduced motion
retain a stationary spectrum border and hide traveling effects.

## Automated and visual checks

CPU tests cover tone-band separation, silence, transient detection, sustained
rises/falls, compact-data validation, deterministic seek sampling, local retry
reuse, worker cancellation/failure, section crossfades, silence inside a chorus,
all comfort modes, Low detail, fixed pools, and absence of physics components.

Production Chromium screenshots were inspected at intro, verse, chorus, and
bridge positions, followed by a second pass for the soft ribbon material.
Artifacts are under `output/playwright/music-stage-*.png` (ignored).

Final checks:

- `bun test`: 331 passed, 50,324 assertions across 47 files.
- `bun check`: no type errors in 366 files.
- `bun run build --outDir output/music-stage-dist`: passed, 468 modules.
- Existing demo, music-visuals, neon, and section-effects browser suites:
  13 passed in 2.7 minutes. This includes DPR 2 resizing, live reduced motion,
  all comfort/detail controls, pause/retry, and the existing shader fallback.
- The complete 72-second demo finished with all six sections and five section
  waves observed: 6,488 points, 62 kills, and 20 health remaining.

The sequential Off/Standard production stress benchmark passed on an Apple
M1 Max (64 GiB), macOS arm64, Bun 1.4.3, Chromium 156.0.8078.4 headless at
1200×924, DPR 1. Each mode measured 600 frames after three seconds of warmup.
The fixture refills 200 enemies and 500 projectiles per fixed step and creates
16 cosmetic death bursts per beat.

| Mode | Mean frame interval | P95 | P99 | Failures |
| --- | ---: | ---: | ---: | ---: |
| Off | 16.666 ms | 16.670 ms | 16.670 ms | 0 |
| Standard | 16.666 ms | 16.670 ms | 16.670 ms | 0 |

Standard observed 197–200 enemies, 457–489 projectiles after collision/expiry,
230–256 shards, and eight rings. Both modes met the existing 60 FPS criterion.
The new stage runs alongside that scene. The benchmark's older
`visualCpuMilliseconds` counter covers the original visuals system only;
the stage exposes its own `musicStage.cpuMs` counter through read-only inspection.

This is a vsync-limited desktop measurement, not a measure of GPU headroom or
a mobile performance claim. Full results are retained in
`output/playwright/music-stage-benchmark.json`; browser artifacts are in
`output/music-stage-browser-results/`.
