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

Local files never upload. Enter a steady tempo and first-beat offset in seconds,
then use the audible metronome preview to check the grid. BPM entry does not
analyze variable-tempo music; those tracks require authored timestamps.
Files are limited to 100 MB / six hours. A local file must be reselected after
reload; only its name/tempo/offset, preferences, and best scores are saved.
Dojo has a six-hour metronome horizon and can be reset at any time.

Settings include master/music/effects gain, graphics detail, reduced flashes,
and visual timing offset. **Positive milliseconds advance the visual pulse;
negative values delay it.** Audio and combat timestamps remain unchanged.
Focus loss, hidden tabs, suspended audio, and long stalls pause the session and
require explicit resume. A load that finishes after focus loss also waits paused.

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
```

The explicit `?stress=1` fixture replenishes 200 enemies and 500 projectiles
before each fixed step and disables contact damage for measurement. It is never
active in normal play. `?test=1` installs a read-only browser inspection API.
See the release document for measured hardware, counts, and frame intervals.

## Structure and timing

| Path | Responsibility |
| --- | --- |
| `src/app/`, `src/stress/` | Shallot plugin composition and opt-in inspection/stress fixture |
| `src/arena/`, `src/player/` | Arena, collision walls, fixed movement, camera projection |
| `src/rhythm/` | Authored timelines and Web Audio transport through public `AudioOutput` |
| `src/combat/`, `src/enemies/` | Seeded waves, pursuit, swept nearest hits, damage and scoring |
| `src/session/` | Menu/loading/play/pause/results, audio/entity/listener ownership |
| `src/presentation/` | Shared materials, shots, hit flashes and bounded damage numbers |
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
There is no Spotify integration, loot system, multiplayer, or beat analysis.

## Static hosting

`public/_headers` preserves Shallot's COOP/COEP isolation headers on compatible
static hosts. `netlify.toml` supplies an optional build configuration; nothing
has been deployed. Other hosts must configure equivalent response headers.
The initial asset paths target the origin root. Review Vite's base and the
manifest audio URL before subdirectory hosting. The production build retains
an upstream engine bundle-size warning; its JavaScript and physics/audio assets
are served locally.
