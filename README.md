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
| Space near the accented first beat | Dash in the movement direction, or aim direction when stationary |
| Escape | Pause / resume outside upgrade selection |
| 1 / 2 / 3, or click a card | Choose a level-up upgrade |
| R in dojo | Reset the run and metronome |
| F3 | Toggle development diagnostics; off by default |

Choose **Neon Circuit**, the original 72-second, 120 BPM demo; enter the dojo at
20–300 BPM; or import a local audio file. Each run starts with four count-in
clicks. Kills award **100 points** and each survived beat awards **2 points**.
Enemy waves grow by musical bars, with a normal-play cap of 100 enemies.
Contact and projectile damage share a 0.9-second invulnerability window. Zero health ends a run;
reaching the end of the audio completes it. Retry and menu navigation work
without reloading.

Player shots start at **13–17 damage**, with a **12% chance of a 2× critical hit**.
Every enemy has a compact health bar. Hits, including killing blows, show their
rolled damage; critical numbers are larger and gold. Numbers appear immediately
at rest, then pop, rise, and fade over one beat starting on the next authored
beat. Hits exactly on a beat begin that motion immediately. Changing tempo,
slowdown, and pause affect the animation with the music. Off/reduced-motion
settings keep the information visible with stationary fades.

Each run owns `combat.playerStats`: base/effective combat stats, named stat
modifiers, and counters for shots, hits, critical hits, and actual damage dealt.
Upgrades use named modifiers without editing the hit loop. Damage, critical
results, and available bounces are captured when a shot fires; existing shots
keep those values, and overkill is excluded from damage totals. See the
[original damage system record](docs/damage-verification.md) and the current
[upgrade verification record](docs/upgrades-verification.md).

Waves mix three enemy types, introduced over the first three bars:

- **Coral chasers** pursue the player and deal contact damage.
- **Violet spinners** spawn at random safe positions inside the arena. Their
  three barrels turn 30° each accented bar start and fire three shots 120° apart.
- **Amber rangers** approach to about six arena units, then fire one straight
  shot aimed at the player's position on each accented bar start while in range.

Enemies arrive in narrow beams on the main beat, spinning, descending and
growing from zero scale over the interval to the next authored beat. Floor
markers show their arrival positions. They become live only when the animation
finishes: before then they cannot move, attack, collide, take hits or show
health bars. Pending arrivals count toward the enemy cap. No new arrival starts
on the final beat or across a detection gap longer than 3.05 seconds.
Pause and slowdown hold or stretch the animation with the music.
Off/reduced-motion settings retain the footprint and growth while removing
the beam, spin and vertical travel. See
[spawn and pacing verification](docs/spawn-pacing-verification.md).

New shooters wait one bar before attacking. Their coral diamond projectiles
travel more slowly than the player's mint shots and never home. All enemy fire
uses the same accented first beat as the dash, including detected tracks with
changing meter; ordinary beats and unaccented inferred boundaries do not fire.
The normal enemy/bullet budgets also apply to these attacks. See
[enemy verification](docs/enemy-types-verification.md) for the behavior checks.

Every enemy drops a **blue XP gem worth 10 experience**. Gems stay on the floor
until collected; move within 3.5 arena units to pull them toward your ship.
Once attracted, they keep following you until picked up, including after a dash.
The blue bar at the top shows your level and progress toward the next one.
You start at level 1; level 2 needs 36 XP, then each next requirement grows by
18 XP. Excess XP carries over, and the results screen shows your final level
and total collected XP. Each run starts fresh.

Level-ups produce blue-and-gold rising particles and expanding rings timed to
a nearby musical subdivision. Comfort settings soften or disable the
celebration while keeping gems and the XP bar visible. Each new level also
offers **three upgrade cards; choose one** by clicking or pressing **1, 2, or 3**.
Music and gameplay briefly slow together as the cards enter, then stop at a
subdivision of the actual local beat. The transition spans 100–140 ms of music,
about **180–250 ms in real time**; slower tempos use finer subdivisions.
The player is protected and movement/dash input is cleared during this
transition. Card entrances use music position, including
the slowdown; reduced-motion settings use stationary fades. Missing detections
and the song tail use a short bounded fade rather than inventing beats.

| Upgrade | Effect per selection |
| --- | --- |
| **Power** | +3 to both ends of the damage range; initially 13–17 → 16–20 |
| **Vitality** | +20 maximum health and restore 20 current health |
| **Regeneration** | +2 health restored every 5 seconds of song time, on the next authored beat |
| **Split Shot** | +1 projectile per normal firing beat, up to 7 |
| **Downbeat Barrage** | Unlock a 6-projectile outward ring on the accented main beat; subsequent selections add 2, up to 24 |
| **Critical Chance** | +5 percentage points, initially 12% → 17%, up to 100% |
| **Critical Damage** | +0.25× critical multiplier, initially 2× → 2.25× |
| **Ricochet** | +1 bounce per projectile, up to 5 |

Split Shot widens the normal shot into a symmetric fan around the aim: 12°
more total spread per added projectile, capped at 60°. Barrage fires a full
ring in addition to that fan, only on actual accented bar starts, using the
same main beat as dash and enemy attacks. Ricochets stop at their impact point,
then launch toward the nearest enemy they have not already hit on the next
beat. Each projectile can bounce at most once per authored beat. All shots
retain the existing projectile budget.

Regeneration starts five song seconds after acquiring it. Each heal lands on
the first authored beat at or after its due time, then starts the next
five-second interval. Slowdown stretches that interval in real time, pause
stops it, and missing beats never release a backlog of heals.

Choices stay fixed while the menu is open. Several levels earned together
queue one choice per level; music stays paused until every choice is made.
Escape cannot skip a selection, and repeated keys/double clicks cannot select
twice. If audio cannot resume after a choice, the upgrade remains applied and
**Resume upgraded run** retries playback without granting it again. Returning
to the menu remains available. Upgrades, choices, and stats reset with the run.
See [XP verification](docs/experience-verification.md) for the gem system and
[upgrade verification](docs/upgrades-verification.md) for the selection flow.

The larger beat indicator sits at the bottom center. Its first diamond gains
an outline and **Dash ready** appears during a ±100 ms window around an
accented bar start. Press **Space** once in that window to dash; holding the
key or pressing off-beat never queues a later dash. Each downbeat allows one
dash. The burst follows local beat timing, stays on the play plane and respects
walls/enemy collisions. It does not grant extra damage immunity.
Automatic tracks use their actual detected downbeats, including changing meter;
unaccented inferred bar boundaries do not grant dashes. Visual calibration
remains cosmetic: dash input is judged against the current audio clock.

Local files never upload. Selecting a file automatically runs Beat This! locally
with WebGPU. It detects individual beats and bar starts, including changing tempo.
Detected timing is selected automatically. Preview with the metronome or play
once analysis finishes. **Timing** contains the optional **Manual BPM** control
and first-beat offset. Displayed BPM is rounded; detected timestamps retain their
full precision.
The preview section selector offers 12 seconds from the start, middle or end,
or the full track. Higher clicks mark bar starts.

Analysis also runs **LinkSeg** locally to estimate intro, verse, chorus, bridge,
instrumental, outro and silence sections. The bottom music player spans the
screen and colors each predicted section, with a playhead, current/next labels
and a legend. The import preview shows the same section map. Section predictions
also drive the arena transitions below; enemy schedules, beat timing and
collision rules remain unchanged. If section analysis fails, detected beats
are still playable. See the [LinkSeg evaluation](docs/section-analysis.md)
for measured performance, predictions and remaining listening review.

In **Standard** effects mode, entering a new detected section sends one
shockwave from the center of the arena toward its edges. The floor and grid
change to the new section's colors as the ring passes, leaving the new theme
behind it. The map, camera and perimeter geometry keep their normal poses
throughout the effect. Perimeter and background colors blend to match the section
timeline: blue for intro, green for verse, gold for chorus, violet for bridge,
cyan for instrumental, rose for outro and dark slate for silence.

Behind the arena, stars travel steadily outward across three depth layers.
Each section shockwave smoothly accelerates them from normal speed to **15×**
speed and back, stretching them into hyperspeed streaks. Travel accumulates
continuously, so returning to normal speed never jumps the stars backward.
The starfield follows the music clock through pause and slowdown, while the
camera keeps its normal view and player follow.

Transitions start at the exact predicted boundary on the raw music clock,
independent of visual calibration. They normally span four actual beat
intervals, following tempo changes; slow tracks use fewer beats to keep the
wave within 3.5 song seconds. Each wave finishes before the next section or
an unusable beat interval. Fragments shorter than 0.65 song seconds and
boundaries inside detection gaps use a short color fade. Pause and slowdown
freeze or stretch the effect with the music. The first section establishes its
colors during count-in without an entrance effect.

The shockwave is cosmetic: movement, dash directions, pointer aiming and
collision rules keep their normal behavior. **Calm** uses a subtler ring and
weaker starfield boost. **Off**, reduced flashes and reduced motion
keep the stars static and use a simple fade between section palettes.
Tracks without section analysis, including demo, dojo and manual-BPM tracks,
retain normal star drift without invented section boosts. Every predicted span
boundary is honored, including
adjacent spans with the same label; the model's estimates still need listening
review. See [section-effects verification](docs/section-effects-verification.md).

`bun run setup:audio` downloads and verifies the pinned 83 MB model and copies
the matching 25.5 MB ONNX runtime from installed dependencies. The same command
prepares the verified 1.57 MB LinkSeg model. These generated binaries are
gitignored and served from the same origin as the game. Selecting a local file
starts analysis. A worker handles inference and is terminated on
completion or cancellation. One decoded local file is reused for analysis,
preview, play and retry; replacing it releases the cached buffer. Analysis
results are session-only. Analysis warning text is omitted from the interface.
When bar starts are unavailable, timing falls back to groups of four beats.

Both ONNX models persist in browser Cache Storage (`beatshooter-models-v1`),
keyed by their pinned SHA-256 hashes. Subsequent tracks and page reloads read
the saved weights without a model network request. Downloads and saved entries
are checked for size and checksum; corrupt entries are fetched again, and updated
weights replace the old version. Storage denial or quota errors fall back to
loading the model normally. Clearing site data or browser eviction also requires
another download. This cache stores model files only, not uploaded music.
The ONNX runtime still initializes a fresh inference session for each analysis;
its JS/WASM assets use normal browser HTTP caching.

Files are limited to 100 MB, six hours, and a post-decode 256 MiB PCM budget
(about 11 minutes at 48 kHz stereo). A local file must be reselected after
reload; only its name/tempo/offset, preferences, and best scores are saved.
Detected-chart scores use a file-content hash plus versioned chart identity.
Dojo has a six-hour metronome horizon; press R during play or pause to reset it.

Settings include master/music/effects gain, graphics detail, reduced flashes,
visual effects intensity, and visual timing offset. **Positive milliseconds advance the visual pulse;
negative values delay it.** Audio and combat timestamps remain unchanged.
Focus loss, hidden tabs, suspended audio, and long stalls pause the session and
require explicit resume. A load that finishes after focus loss also waits paused.

The arena's floor patterns, bar ripples, perimeter lights, death shards and
damage-number envelopes follow the same music clock. Section transitions change
floor colors behind an outward-moving ring; the map geometry, play plane, collision
boundaries, camera orientation and aiming remain stable. Deaths and scores resolve immediately;
larger death accents wait at most 100 ms for a nearby sixteenth-note subdivision.
When no suitable subdivision exists, a small local dissolve confirms the kill.
Long detection gaps settle the decoration without inventing extra beats.

In **Settings → Visual effects**, choose **Standard** for the full effect set,
including section shockwaves, **Calm** for softer motion, or **Off** for a stationary
arena with essential feedback and section color changes. Graphics detail
controls rendering cost independently. **Reduced flashes** and the device's
**reduced-motion** preference disable travelling decoration and section rings
while keeping small local fades. Automatic local-track analysis also
computes optional 20 Hz loudness/bass curves in its existing worker; these
modulate detail without triggering beats. Demo, dojo and manual-BPM tracks use
a neutral energy response.

The earlier floor and particle implementation passed production browser checks
and the dense 60 FPS stress fixture on the recorded M1 Max. All four local test
tracks pass energy integration without changing detected timestamps. Human listening and
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

# Same dense fixture with maximum projectile and ricochet upgrades
bun ./tests/browser-stress.ts http://127.0.0.1:4175 --upgraded

# Off/Standard visual comparison with dense, repeatable death bursts
bun tests/music-visuals-benchmark.ts http://127.0.0.1:4175

# Full Beat This! experiment, using private files from gitignored local-audio/
bun tests/audio-analysis.ts http://127.0.0.1:4175
```

The explicit `?stress=1` fixture replenishes 200 enemies and 500 projectiles
before each fixed step and disables contact damage for measurement. It raises
the first level requirement to 1,000,000 XP solely to keep profiling
uninterrupted; real XP drops and pickup remain active. This fixture is never
active in normal play. Adding `&visualStress=1` emits 16 cosmetic kill events
per beat to exercise the particle caps. `?test=1` installs a read-only browser inspection API.
See the release document for measured hardware, counts, and frame intervals.

## Structure and timing

| Path | Responsibility |
| --- | --- |
| `src/app/`, `src/stress/` | Shallot plugin composition and opt-in inspection/stress fixture |
| `src/arena/`, `src/player/` | Arena, collision walls, fixed movement, camera projection |
| `src/dash/` | Downbeat input windows, single-use dash state and music-timed movement targets |
| `src/rhythm/` | Authored timelines, shared musical visual sampling, and Web Audio transport through public `AudioOutput` |
| `src/analysis/` | Local Beat This! worker, preprocessing, chart validation, bar mapping and optional energy curves |
| `src/combat/`, `src/enemies/` | Seeded waves, arrival reservations and activation, pursuit, swept nearest hits, damage and scoring |
| `src/enemy-spawn/` | Music-timed beam, spin and growth previews without physics or combat participation |
| `src/player-stats/`, `src/upgrades/` | Per-run stats/modifiers, damage accounting, upgrade catalog, seeded three-card offers and queued choices |
| `src/experience/` | Persistent XP drops, swept attraction/collection, run levels and musical gem presentation |
| `src/session/` | Menu/loading/play/pause/upgrade/results, synchronized slowdown and selection, audio/entity/listener ownership |
| `src/music-visuals/` | Floor shader, bounded musical effect queues, pooled shards/rings and comfort controls |
| `src/section-effects/` | Detected-section timing, dark palettes and music-timed floor color transitions |
| `src/starfield/` | Continuous music-clock travel, integrated section speed boosts and pooled background stars |
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
There is no Spotify integration, equipment system or multiplayer. Automatic analysis
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
