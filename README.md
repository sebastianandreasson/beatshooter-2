# Beatshooter 2

A single-player, top-down music shooter built directly with Shallot 0.10.0.
Move around the arena, aim with the pointer, and let your weapon fire on the
music's beats. Survive the track or practice in the dojo.

The M0–M6 implementation is present. The [implementation plan](implementation-plan.md)
records scope and acceptance evidence; the [release smoke test](docs/release-smoke.md)
records browser checks, performance measurements, and the remaining human
headphone/display latency check. Deployment is outside this scope.

## Play and develop

Use **Bun 1.4.3 or newer** and a desktop browser with WebGPU on localhost or HTTPS.
The engine remains pinned to `@dylanebert/shallot@0.10.0`.

```sh
bun --version
bun install --frozen-lockfile
bun run setup:audio
bun run dev
```

The shell on the implementation machine has Bun 1.3.11; verification used an
isolated Bun 1.4.3 installation without changing the global installation. Select
Bun 1.4.3+ before running these commands.

| Control | Action |
| --- | --- |
| WASD / arrow keys | Move; diagonals are normalized |
| Pointer | Aim at the reticle |
| Musical beat | Fire automatically |
| Escape | Pause / resume |
| R in dojo | Reset position, movement, enemies, score, and metronome |
| F3 | Toggle development diagnostics; off by default |

Choose **Neon Circuit**, the original 72-second, 120 BPM demo; enter the dojo at
20–300 BPM; or import a local audio file. Each run starts with four count-in
clicks. Kills award **100 points** and each survived beat awards **2 points**.
Enemy waves grow by musical bars, with a normal-play cap of 100 enemies.
Contact damage has a 0.9-second invulnerability window. Zero health ends a run;
reaching the end of the audio completes it. Retry and menu navigation work
without reloading.

Local files never upload. Select a file and click **Analyze beats** to run the
experimental Beat This! model locally with WebGPU. It detects individual beats
and bar starts, including changing tempo. Preview with the metronome before
playing; **Detected beats** uses that exact timeline. **Manual BPM** remains
available for a steady tempo and first-beat offset.
The preview section selector offers 12 seconds from the start, middle or end,
or the full track. Higher clicks mark bar starts.

`bun run setup:audio` downloads and verifies the pinned 83 MB model and copies
the matching 25.5 MB ONNX runtime from installed dependencies. These generated
binaries are gitignored and served from the same origin as the game. Analysis
does not run until requested. A worker handles inference and is terminated on
completion or cancellation. One decoded local file is reused for analysis,
preview, play and retry; replacing it releases the cached buffer. Analysis
results are session-only. Detection can be wrong; warnings flag irregular
timing, and unavailable bar starts use explicitly labeled groups of four beats.

Files are limited to 100 MB, six hours, and a post-decode 256 MiB PCM budget
(about 11 minutes at 48 kHz stereo). A local file must be reselected after
reload; only its name/tempo/offset, preferences, and best scores are saved.
Detected-chart scores use a file-content hash plus versioned chart identity.
Dojo has a six-hour metronome horizon and can be reset at any time.

Settings include master/music/effects gain, graphics detail, reduced flashes,
visual effects intensity, and visual timing offset. **Positive milliseconds advance the visual pulse;
negative values delay it.** Audio and combat timestamps remain unchanged.
Focus loss, hidden tabs, suspended audio, and long stalls pause the session and
require explicit resume. A load that finishes after focus loss also waits paused.

The arena's floor patterns, bar ripples, perimeter lights, death shards and
damage-number envelopes follow the same music clock. Floor geometry, collision
boundaries and aiming remain stable. Deaths and scores resolve immediately;
larger death accents wait at most 100 ms for a nearby sixteenth-note subdivision.
When no suitable subdivision exists, a small local dissolve confirms the kill.
Long detection gaps settle the decoration without inventing extra beats.

In **Settings → Visual effects**, choose **Standard** for the full restrained
effect set, **Calm** for softer motion, or **Off** for a static arena and essential
feedback. Graphics detail controls rendering cost independently. **Reduced
flashes** and the device's **reduced-motion** preference disable travelling
decoration and keep small local fades. Automatic local-track analysis also
computes optional 20 Hz loudness/bass curves in its existing worker; these
modulate detail without triggering beats. Demo, dojo and manual-BPM tracks use
a neutral energy response.

The visual implementation passes production browser checks and the dense
60 FPS stress fixture on the recorded M1 Max. All four local test tracks pass
energy integration without changing detected timestamps. Human listening and
comfort review remains open. See the
[visual implementation record](docs/music-visuals-plan.md) and
[verification record](docs/music-visuals-verification.md). The earlier M0–M6
release evidence is separate from the new visual measurements.

## Verification

```sh
bun check
bun test
bun test ./tests/player.node.ts
bunx playwright install chromium
bunx playwright test --workers=1
bun run build
bun run preview
```

The tests cover the actual Shallot solver, fake and real Web Audio clocks,
swept collision/filtering, deterministic combat, settings corruption, production
startup/error handling, local files, pause and loading cancellation, and repeated
retries. Browser tests run against the production build. The original welcome
fixture remains as a small upstream baseline test; it is not the application.

Performance checks:

```sh
# Pure combat: 200 enemies / 500 projectiles, deterministic replay
bun ./tests/stress.ts

# Real renderer + physics + audio + HUD; start preview separately on port 4175
bun run preview --port 4175 --strictPort
bun ./tests/browser-stress.ts http://127.0.0.1:4175

# Off/Standard visual comparison with dense, repeatable death bursts
bun tests/music-visuals-benchmark.ts http://127.0.0.1:4175

# Full Beat This! experiment, using private files from gitignored local-audio/
bun tests/audio-analysis.ts http://127.0.0.1:4175
```

The explicit `?stress=1` fixture replenishes 200 enemies and 500 projectiles
before each fixed step and disables contact damage for measurement. It is never
active in normal play. Adding `&visualStress=1` emits 16 cosmetic kill events
per beat to exercise the particle caps. `?test=1` installs a read-only browser inspection API.
See the release document for measured hardware, counts, and frame intervals.

## Structure and timing

| Path | Responsibility |
| --- | --- |
| `src/app/`, `src/stress/` | Shallot plugin composition and opt-in inspection/stress fixture |
| `src/arena/`, `src/player/` | Arena, collision walls, fixed movement, camera projection |
| `src/rhythm/` | Authored timelines, shared musical visual sampling, and Web Audio transport through public `AudioOutput` |
| `src/analysis/` | Local Beat This! worker, preprocessing, chart validation, bar mapping and optional energy curves |
| `src/combat/`, `src/enemies/` | Seeded waves, pursuit, swept nearest hits, damage and scoring |
| `src/session/` | Menu/loading/play/pause/results, audio/entity/listener ownership |
| `src/music-visuals/` | Floor shader, bounded musical effect queues, pooled shards/rings and comfort controls |
| `src/presentation/` | Shared combat materials, steady damage tint and music-timed damage numbers |
| `src/tracks/`, `public/tracks/` | Validated manifests, local decoding, original demo and generator |
| `src/ui/`, `src/settings/` | Responsive DOM interface and validated versioned preferences |
| `tests/` | Physics, browser acceptance, and stress checks |

Movement uses Shallot bodies with zero gravity and planar locks. Ordered fixed
systems consume accepted beat commands, drive physics, resolve swept projectile
hits, and clean up dead entities. Rendering interpolates placement. Music
position comes from the audio context's scheduled time, not accumulated frame
deltas. Authored beats are delivered once in order; long stalls do not release
a backlog. Live clock/device input is external, so deterministic combat tests
use injected beat commands rather than claiming identical live replays.

This is a fresh implementation. No application code, dependencies, credentials,
or assets were copied from `../beatshooter`. The demo music, artwork, icon, and
sound effects are original; see [asset credits](public/tracks/CREDITS.md).
There is no Spotify integration, loot system or multiplayer. Automatic analysis
is a local prototype; see [analysis notes](docs/beat-this-prototype.md) and
[model/runtime credits](public/models/README.md).

## Static hosting

`public/_headers` preserves Shallot's COOP/COEP isolation headers on compatible
static hosts. `netlify.toml` supplies an optional build configuration; nothing
has been deployed. Other hosts must configure equivalent response headers.
The initial asset paths target the origin root. Review Vite's base and the
manifest audio URL before subdirectory hosting. The production build retains
an upstream engine bundle-size warning; its JavaScript and physics/audio assets
are served locally.
