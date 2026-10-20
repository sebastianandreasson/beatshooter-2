# Music visuals verification

2026-10-20. **Implemented; automated verification passed.** Production browser,
frame-time and local-track results are recorded below. Human listening/comfort
review remains open. Earlier M0–M6 evidence is separate from this verification.

## Implemented scope

The [implementation record](music-visuals-plan.md) describes the shared musical
sampler, floor shader, bounded death/shot/spawn effects, music-timed damage
feedback, comfort controls and optional energy curves. Combat scoring, damage,
collision timing and RNG remain independent of visual settings.

Open **Settings → Visual effects** to compare Standard, Calm and Off. Graphics
detail is separate. Reduced flashes and OS reduced motion suppress travelling
decoration. For local files, click **Analyze beats** again to produce the new
energy metadata, then play with **Detected beats**. Manual BPM, demo and dojo
use neutral energy. The analysis worker reads existing mono PCM; it does not
upload files or change Beat This! input samples.

## Automated evidence

| Area | Coverage | Status |
| --- | --- | --- |
| Musical sampling | Variable tempo, pickups, inferred bars, unusual meter, gap/end guards, calibration and stateless sampling | Passed |
| Event ownership | Multiple fixed steps, duplicate/generation rejection, pause/clear, stale bursts, caps, priority and merging | Passed |
| Simulation independence | Same recorded combat commands with Off/Calm and differing particle budgets preserve full state and RNG | Passed |
| Energy/preferences | Silence and bass response, malformed curves, preserved PCM/chart identity, old saved preferences | Passed |
| Production browser | Shader startup/fallback, pause/retry, controls persistence, live reduced motion and calibration edits | Passed |
| Performance | Production 200-enemy/500-projectile fixture, repeatable effect bursts, Off/Standard comparison and frame-time tails | 60 FPS target passed on recorded machine |

Commands used with Bun 1.4.3:

```sh
bun check
bun test
bunx playwright test --workers=1
bunx playwright test tests/music-visuals.e2e.ts --workers=1
bun run preview --port 4175 --strictPort
bun tests/music-visuals-benchmark.ts http://127.0.0.1:4175
bun tests/audio-analysis.ts http://127.0.0.1:4175
```

- Type checking: **284 files**, no errors.
- Unit suite: **105 tests / 7,449 assertions**, all passed. Includes analytic
  particle comparisons after simulated 30/60/144 Hz render histories.
- Full production browser run: **30 tests passed**, including the 72-second
  demo, ten retries, focus-loss pause, local-file completion and DPR 2 aiming.
- After the final paused-calibration fix, all **5 visual browser tests passed**
  on a rebuilt production bundle. This includes one additional regression:
  changing the offset while paused clears old visual births without moving
  the accepted music position or combat. There are **31 distinct passing browser
  cases** across these runs.
- Real invalid WGSL injected into the optional floor preflight retains the
  original static floor/grid and a playable session with no uncaught errors.
- Production build passed. Vite retains the existing large-chunk advisory;
  no build error occurred.

Browser tests witness actual GPU uniforms and particle transforms, including
held poses during pause and empty pools after retry. Low graphics at DPR 2
also passed calibration and rendering checks. Screenshot inspection found the
floor below combat silhouettes at both High and Low, with a clear reticle in
the dense High capture.
Static captures do not establish perceived synchronization or comfort over time.

Local captures:

- `output/playwright/music-stress-standard.png`
- `output/playwright/music-stress-off.png`
- `output/playwright/music-floor-low-dpr2.png`

## Production performance

Apple M1 Max / Metal 3, macOS arm64, Chromium 156.0.8078.4, Bun 1.4.3;
1200×924 viewport, DPR 1, High graphics. Fresh Off and Standard browser contexts
ran sequentially, with three seconds of warmup and 600 measured frames each.
The fixture refills 200 enemies and 500 projectiles before each fixed step and
injects 16 cosmetic kills per beat. Normal gameplay never enables this fixture.

| Measurement | Off | Standard |
| --- | ---: | ---: |
| Mean frame interval | 16.666 ms | 16.666 ms |
| 95th / 99th percentile frame interval | 16.670 / 16.670 ms | 16.670 / 16.670 ms |
| Mean measured visual CPU work | 0.040 ms | 0.125 ms |
| 95th percentile measured visual CPU work | 0.050 ms | 0.150 ms |
| Peak shards / rings / pending bursts | 0 / 0 / 0 | 256 / 8 / 16 |

Both runs met the 60 FPS target. Standard added **0.085 ms mean CPU work**
in event consumption, particle updates and floor uniform uploads. This
instrumentation excludes musical-frame sampling, damage-number DOM and
renderer/GPU work. Vsync-paced frame intervals do **not** establish GPU headroom
or the proposed 2 ms incremental GPU budget. Separate GPU timings were not
available in this measurement; no such claim is made. Low/Off suppress shader
layers visually but do not skip all corresponding shader arithmetic.

After each run, session entities, sounds, visible particles, pending bursts
and damage feedback returned to zero. The fixed hidden pool retains its
256-slot capacity for reuse. No page errors occurred.
See the [measurement record](music-visuals-performance-2026-10-20.json).

## Local-track browser verification

The generated demo and all four private tracks passed full-file WebGPU analysis,
valid 20 Hz energy-curve generation, preview, detected-chart gameplay, retry
and menu cleanup. The actual floor inputs matched energy sampled at the shared
musical position. The inspection API returns owned copies of energy arrays.
Missing-model recovery and cancellation also passed.

| Private track | Analysis including worker/model setup | Energy frames | Timing parity |
| --- | ---: | ---: | --- |
| Hyper Spoiler | 5.03 s | 5,441 | Exact |
| I Can't | 4.46 s | 3,767 | Exact |
| Magna Divide | 5.54 s | 5,124 | Exact |
| Siriusmo Itchy from Enthusiast | 5.88 s | 4,253 | Exact |

Every beat/downbeat timestamp still matches the saved official Beat This
reference for the same inputs; the Python model was not rerun for this check.
The demo again matched all 144 authored beats and 36 downbeats within 70 ms.
Hyper Spoiler's initial long gap exercised the quiet visual guard during real
gameplay. No unexpected network requests or uncaught page errors occurred.
Audio/PCM remain ignored local files.
See the [browser and parity record](music-visuals-audio-2026-10-20.json).

## Optional energy cost

Measured locally with **Bun 1.4.3 on the development M1 Max**, using the exact
22050 Hz mono PCM previously exported by the browser analysis pipeline.
These are one-pass CPU observations, **not browser inference or frame times**.
No audio or PCM is included in this document.

| Private track | Duration | 20 Hz frames | Calculation | Serialized curves |
| --- | ---: | ---: | ---: | ---: |
| Hyper Spoiler | 272.04 s | 5,441 | 33 ms | 207 KB |
| I Can't | 188.32 s | 3,767 | 26 ms | 141 KB |
| Magna Divide | 256.16 s | 5,124 | 33 ms | 194 KB |
| Siriusmo Itchy from Enthusiast | 212.61 s | 4,253 | 45 ms | 163 KB |

The implementation uses short RMS windows and lightweight low-band filters,
a track-relative reference with a silence floor, and smoothed envelopes.
Both loudness and bass share the RMS reference so tiny bass leakage in a
treble-only passage cannot normalize to maximum intensity. Curves affect
decorative strength only; they neither identify song sections nor add beats.

## Human review still required

Review the demo and all four private tracks with the intended audio device and
display. Include quiet breakdowns, busy combat, fast passages, and tracks with
irregular detections. Check the whole image for distracting brightness changes,
reticle/enemy visibility and fatigue, and compare Calm or reduced settings.

Record feedback as **track, timestamp, setting and observation**: whether the
floor follows the music, a death accent feels late, or motion obscures a threat.
The 100 ms decorative-wait limit and current brightness/particle caps remain
tuning choices until this review. Automated timing checks do not certify
perceived latency or flash safety.
