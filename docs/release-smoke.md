# Release smoke test

This is the local release checklist for the first playable. Deployment is a
separate task. The evidence column distinguishes automated browser checks from
observations that require a person listening or playing on the named device.

## Reproduce the release build

Use Bun 1.4.3 or newer, with the exact engine version and committed lockfile.

```sh
bun --version
bun install --frozen-lockfile
bun check
bun test
bun test ./tests/player.node.ts
bunx playwright install chromium
bunx playwright test --workers=1
bun ./tests/stress.ts
bun run build
bun run preview
```

Open the preview URL printed by Vite. Check this production preview, since Vite
development mode alone does not establish that built assets or startup paths
work. The optional `netlify.toml` describes a root-path static build, without
creating or publishing a deployment.

## Hosting and assets

`public/_headers` is copied to `dist/_headers`. A host supporting Netlify-style
header files must send these headers on the document and assets:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For another static host, configure the same response headers using that host's
native rules. HTTPS is required outside localhost. After publication, inspect
the real response headers and confirm `window.crossOriginIsolated === true`.
An `_headers` file sitting on an arbitrary file server does not configure it.
See [Netlify custom headers](https://docs.netlify.com/manage/routing/headers/)
and [MDN cross-origin embedding policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy).

Check that the built JavaScript, icon, track manifest, artwork, and WAV return
200 from the same origin. The initial configuration targets the origin root;
subdirectory hosting requires a Vite base-path review. The generated demo's
source and license are in `public/tracks/CREDITS.md`. Local files remain on the
device and must be selected again after a reload.

## Functional playthrough

Record browser name/version, OS, hardware, viewport, and input/output devices
with each completed run. Check one desktop Chromium browser with WebGPU; test
other browsers only where WebGPU and the required audio capabilities are
available.

Automated run on 2026-10-20: **26/26 production-browser tests passed in 2.7
minutes**, using Playwright Chromium **156.0.8078.4**, macOS on the Apple M1 Max
desktop described below, default 1280×720 viewport, device pixel ratio 1.
Movement/aim tests additionally used 1280×800 and 1000×700, with a separate
DPR 2 boundary/resize run. Menus and dialogs were checked at 390×844 and
1280×800, including overflow, focus trapping, and metadata persistence. The production
preview returned both isolation headers and `crossOriginIsolated === true`.
Sources: [startup checks](../startup.e2e.ts),
[gameplay checks](../tests/gameplay.e2e.ts),
[release checks](../tests/release.e2e.ts), and
[real Web Audio checks](../tests/rhythm.e2e.ts),
[full demo and boundary checks](../tests/demo-playthrough.e2e.ts), and
[responsive UI checks](../tests/ui.e2e.ts). Type checking, all **52 unit tests**
(263 assertions), the explicit **real-physics integration test** (7 assertions),
and the production build also passed. CI is configured for macOS/Linux/Windows;
this local evidence is from macOS.

| Scenario | Expected behavior | Evidence |
| --- | --- | --- |
| Fresh load | Menu replaces loading screen, no forced diagnostics, no uncaught page errors | Passed startup/render handoff, hidden diagnostics, and zero unexpected page-error assertions in normal release flows |
| No WebGPU | Useful unsupported-browser error; no infinite loading state | Passed with `navigator.gpu` unavailable: engine support message and browser-support link appear; only the expected unsupported-WebGPU startup rejection is permitted |
| Demo start | An explicit click starts audio and gameplay; no early shot before scheduled start | Passed actual demo start; count-in reset checked in ten retry runs; fake-clock tests cover beat-zero timing |
| Movement | WASD/arrows, normalized diagonals, planar motion, boundary collision | Browser W+D movement, speed bound, Y lock and reset passed; explicit physics integration covers normalized velocity/reset. Sustained movement into the right wall stays between X=17.2 and X=17.5 |
| Aim and resize | Reticle follows pointer after movement, window resize, and high-DPI scaling | Passed projection after camera follow and resizing within 2 CSS pixels at DPR 1 and DPR 2 |
| Combat | Beat fire, readable shots/hits/numbers, capped enemy pressure, kills and score | Full demo won using only keyboard/mouse inputs; deterministic tests cover swept hits, filtering, critical damage, expiry and caps. Captured gameplay/stress screenshots visually inspected |
| Defeat | Contact damage respects invulnerability, zero health opens results | Actual demo reaches defeat results naturally with health zero and score retained; unit checks cover the invulnerability window |
| Song completion | Demo reaches results once; final progress and score are retained | Full 72-second demo completed with 58 kills, 6,088 points, 55 health, zero pending commands/sounds, and clean menu return; local WAV also completes twice and saves best score |
| Pause and resume | Audio and all gameplay freeze; explicit resume continues with no shot burst | Passed unchanged transport position, combat state and player position while paused; explicit resume advances again |
| Hidden tab/focus loss | Session pauses, returns to a useful overlay, resumes only on request | Browser blur event passed while playing and while a demo load was delayed; loading completes into a frozen paused session. Timeline tests cover hiding/backlog rejection |
| Audio suspension | Suspended/interrupted output pauses rather than silently advancing gameplay | Real `AudioContext.suspend()` integration passed; resume recreates playback without duplicate accepted beats |
| Ten retries | Each retry resets health/score/entities; no duplicate inputs, effects, or overlapping music | Ten live dojo retries passed: one generation increment each, original body/entity counts, empty pending queue/effects, zero old sounds, fresh count-in |
| Return to menu | Session entities and sounds stop; track selection remains usable | Passed after retries, local completion, natural defeat and cancelled loading |
| Dojo | Adjustable metronome, indefinite practice, clear beat indicator, easy reset | Browser dojo start/reset and real metronome signal passed; tempo generation is covered by unit tests |
| Local file | A valid file with BPM/offset can start, pause, complete, and retry | Real browser decoded a generated WAV, completed twice through normal playback, saved its score and required reselection after reload; transport pause is independently covered |
| Local-file cancellation | Superseded or cancelled loading does not start an old track later | Passed delayed preview file read superseded by a new file, plus delayed demo HTTP cancellation; stale work never revives playback |
| Invalid file/timing | Decode or timeline errors show actionable text and keep the menu usable | Passed BPM validation, invalid WAV decode, missing demo HTTP 404, and recovery into dojo; unit tests cover invalid authored timelines |
| Calibration | Preview is audible; offset units/sign match the displayed explanation | Actual audio signal and click scheduling verified with a real AudioContext/analyser; delayed preview cancellation passes. Human perception/device latency remains unverified |
| Settings | Master/music/effects, offset, graphics preferences, and best results survive reload | Browser master gain, offset, graphics, reduced-flash settings and local best score persistence passed; volume validation is unit-tested |
| Corrupted storage | Loading recovers safely; reset preferences restores validated defaults | Passed malformed stored JSON both on reload and when resetting an already open settings screen |
| Reload | No sound before a gesture; session-only audio requires file reselection | Menu reset, filename/BPM/offset restoration with an empty file picker, and explicit file reselection passed; startup produces no session sounds before interaction |
| Production assets | Built files and track assets resolve without development-server assumptions | Passed entry JavaScript, manifest, WAV RIFF header, SVG artwork/icon and copied `_headers`; document responses include COOP/COEP |

## Perceptual audio timing

The generated track has authored constant-tempo timestamps. Fake-clock tests
can establish timestamp delivery and transport bookkeeping, but cannot measure
the perceived relationship between a speaker/headphone click and the displayed
beat pulse.

Listen through the entire demo while watching beat/downbeat pulses. Test start,
pause/resume, and local-file preview. Record whether the first, middle, and last
bars remain aligned and whether the same calibration remains useful throughout.
Use wired output first; Bluetooth introduces device-dependent buffering.

| Field | Observation |
| --- | --- |
| Date and observer | Pending human observation |
| Browser/version and OS | Pending |
| Machine/display and refresh rate | Pending |
| Audio device and wired/wireless connection | Pending |
| Master/music/effects gain | Pending |
| Timing offset in milliseconds | Pending |
| Start/middle/end alignment | Pending |
| Pause/resume alignment and absence of bursts | Pending |
| Local-file preview and chosen BPM/first-beat offset | Pending |

No automated test or CPU measurement in this repository claims that audio has
been heard or that device latency has been perceptually verified.

The final browser-driven demo used ordinary keyboard/pointer events around an
eight-unit square, with no health/clock/result mutation. Its timestamped
[playthrough record](playthrough-2026-10-20.json) includes checkpoints and the
final result. A wider twelve-unit route also completed, with 10 health remaining.
The regression uses the inner route to tolerate input scheduling differences.

## Performance evidence

Initial stress target: 200 enemies and 500 projectiles at 60 frames per second
on a named desktop. This target was met on the measured M1 Max. Normal gameplay
keeps the lower 100-enemy cap for readability and difficulty. No equivalent
performance claim is made for other hardware; low graphics disables MSAA and
renders at 540 pixels high.

`bun ./tests/stress.ts` keeps 200 enemies and 500 projectiles at the start of
every measured fixed step, warms up for 120 ticks, then measures 600 ticks at a
simulated 60 Hz. It prints OS/CPU/memory/runtime metadata, mean/p50/p95/p99/max
combat time, and a checksum checked by a second deterministic run. Projectile
refill, rendering, audio, and Shallot physics are outside the timed section.

`bun ./tests/browser-stress.ts http://127.0.0.1:4175` measures an already running
production preview. It warms up for three seconds and records 600 animation
frame intervals with the real renderer, physics, audio, combat, and HUD active.
The fixture refills 200 enemies and 500 projectiles before every fixed step;
observations after hits/expiry naturally contain fewer projectiles. Frame
intervals include display pacing and read-only inspection overhead, not just
GPU execution time. Returning to the menu verifies cleanup.

| Measurement | Evidence |
| --- | --- |
| CPU combat benchmark | 2026-10-20; Apple M1 Max, 10 logical cores, 64 GiB RAM, macOS Darwin 24.6.0 arm64, Bun 1.4.3. 600 measured ticks: mean 0.370 ms, p50 0.347 ms, p95 0.380 ms, p99 1.554 ms, max 1.949 ms |
| Browser renderer + physics stress | Same M1 Max; Chromium 156.0.8078.4, headless, Apple Metal 3 adapter, cross-origin isolation enabled |
| Resolution and graphics settings | 1200×924 CSS pixels, DPR 1, High graphics, normal flashes, audio playing |
| Frame interval mean/p95/p99 and approximate FPS | Mean 16.666 ms; p95/p99/max 16.670 ms; average 60.002 FPS. Timestamp rounding tolerance 0.1 ms |
| Peak enemies/projectiles/effects and cleanup after exit | After collision: 197–200 enemies, 443–489 projectiles, 100 effects. Menu exit: zero session entities and sounds |
| Revised supported target | Original 200/500-at-60 target met on this desktop; retain 100-enemy gameplay cap and CPU-authoritative, bounded cosmetic feedback. Extra GPU particles are unnecessary for this release |

The timestamped [browser performance record](performance-2026-10-20.json)
contains the environment, scope, frame statistics, population ranges, and cleanup
witness. `output/playwright/stress.png` is generated by the script for local
visual inspection. A separate headed Chrome 155 development run sustained about
120 FPS on this display; the production figure above is the reproducible
release measurement.

Final CPU run: seed `20261020`, 120 warmup ticks, 600 measured ticks,
200 enemies and 500 projectiles entering every tick. Final state retained
200 enemies, 488 surviving projectiles, and 100 effects at the 100-effect cap.
A second run produced the same checksum, `fcc4189567d89ee3`.
