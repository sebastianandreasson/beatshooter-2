# Beatshooter 2

A single-player, top-down music shooter built directly with Shallot 0.10.1-next.2.
Move around the arena, aim with the pointer, and let your weapon fire on the
music's beats. Survive the track or practice in the dojo.

The M0–M6 implementation is present. The [implementation plan](implementation-plan.md)
records scope and acceptance evidence; the [release smoke test](docs/release-smoke.md)
records browser checks, performance measurements, and the remaining human
headphone/display latency check. Cloudflare hosting is documented separately in
[Cloudflare deployment](docs/cloudflare-deployment.md).

## Music library and campaign runs

Open **Music library & playlists** to import multiple recordings. Audio stays in
this browser's IndexedDB library; each original is identified by its SHA-256
hash, so importing it again does not duplicate it. Beat This! and LinkSeg run
locally, one track at a time. Failed analysis keeps the recording and offers
retry or manual BPM/first-beat timing. Saved tracks have **Preview timing** and
**Quick Play** controls, plus title/artist editing and exact-file relinking.

Build and save an ordered playlist. Ten songs is the suggested length; shorter
playlists work too. Add repeated songs explicitly and check the total duration
before starting. **Quick Play** and **Practice** are independent single-song
sessions and never replace a saved campaign.

A campaign grants one starting upgrade, then presents three arena choices for
each song. The music follows the playlist; the choice changes the encounter:
Mixed Assault, Swarm Nest, Marksman Outpost, Spinner Crossfire, Elite Hunt or
Pulse Grid. The route shows future songs, cleared arenas, the current build,
challenge rules and completion rewards. Campaigns start with twice the original
enemy pressure. Each cleared song adds 35% of the first song's baseline to spawn
rate and enemy health, including beyond song ten. Within each song, spawn rate
rises to 2.5× its opening rate and enemy health to 1.9× its opening health;
pursuit speed also increases. Waves release on downbeats and live enemies plus
pending arrivals share the 100-enemy arena limit.

Level, partial XP, upgrades, score and combat metrics carry between songs.
Clearing a song collects every already-dropped XP gem, awards the arena bonus,
resolves pending upgrades and restores full upgraded health. The last song ends
the campaign; death ends it immediately. No enemies or hazards continue dealing
damage on the route screen. Trap warnings and locked firing lines follow the
actual chart and remain visible when visual effects are off.

**Save & exit** keeps the last song-entry checkpoint. Continue replays that song
from the beginning with the same arena, entry build and random seeds; gains made
inside an unfinished attempt are replayed. Ordinary pause keeps the exact state
in memory. Cleared songs and intermission choices commit atomically. Failed saves
stay paused with Retry, recovery export and a way to reload the last committed
checkpoint. Abandoning a run is separate and requires confirmation.

Only one tab can own a campaign. Library analysis pauses for playback, including
playback in another tab. Original audio and chart revisions used by an active
campaign are protected from deletion. Editing a playlist or reanalyzing a song
changes future runs without changing an existing campaign.

Use **Save & recovery** to inspect storage, request persistence and export/import
a recovery JSON. **Audio is not included**: retain your originals and relink them
after restoring elsewhere. Browser data is local to this device, browser and
site address, including its port; clearing site data removes the library and
checkpoints. Quick Play remains usable if persistent storage is unavailable.

See the [campaign verification](docs/campaign-verification.md),
[library verification](docs/library-verification.md), and
[encounter verification](docs/encounter-verification.md).

## Play and develop

Use **Bun 1.4.3 or newer** and a desktop browser with WebGPU on localhost or HTTPS.
The engine is pinned to `@dylanebert/shallot@0.10.1-next.2`.

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
| Space on any beat, once per bar | Dash in the movement direction, or aim direction when stationary |
| Escape | Pause / resume, keeping pending upgrades |
| 1 / 2 / 3, or click a card | Select a starting or level-up upgrade |
| R in dojo | Reset the run and metronome |
| F3 | Toggle development diagnostics; off by default |

Choose **Neon Circuit**, the original 72-second, 120 BPM demo; enter the dojo at
20–300 BPM; or import a local audio file. Each Quick Play or Practice session first offers a full-screen **Start of run
upgrade** choice. Each new run or restart rolls three random, distinct options.
Choose one free upgrade before the music starts; then four
count-in clicks lead into play. Kills award **100 points** and each survived beat awards **2 points**.
Enemy waves grow by musical bars, with a normal-play cap of 100 enemies.
Each section after the first increases enemy health by **10%**, compounded from
the original health and rounded to whole HP. Live enemies keep approximately
their current health percentage; arriving and future enemies receive the same
scaling. Repeated section labels still count as new sections. The dojo and
tracks without section data keep baseline health.
Contact and projectile damage share a 0.9-second invulnerability window. Zero health ends a run;
reaching the end of the audio completes it. Retry and menu navigation work
without reloading.

Neon Circuit has six authored sections: intro (0–8s), verse (8–24s), chorus
(24–40s), bridge (40–48s), chorus (48–64s), and outro (64–72s). The sound changes
with each section, and its bundled section map drives the same colored progress
bar and arena transitions as analyzed imports. No analysis is needed to play
the demo. Regenerating `src/tracks/generate-demo.py` updates both the music and
the matching section boundaries.

Player shots start at **13–17 damage**, with a **12% chance of a 2× critical hit**.
Every enemy has a compact health bar. Hits, including killing blows, show their
rolled damage; critical numbers are larger and gold. Numbers appear immediately
at 55% size, then pop to 145% (160% for critical hits) on the next authored beat.
They settle to a readable size, briefly hold their position, and rise/fade over
that beat. Hits exactly on a beat pop immediately. Changing tempo,
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

Chasers and approaching rangers move in distinct beat bursts: a fast start,
deceleration over the first 55% of the interval, then a full stop until the
next beat. Ordinary tempos preserve average pursuit speed; slow songs cap
each stride's distance. Movement follows accepted audio timestamps, including
tempo changes, and never repeats a burst during detection gaps or extra physics
ticks. Knockback still responds immediately to hits.
See the [beat pulse verification](docs/beat-pulse-verification.md) for timing and
playthrough checks.

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
Pickup Radius upgrades extend that attraction range.
Once attracted, they keep following you until picked up, including after a dash.
The blue bar at the top shows your level and progress toward the next one.
You start at level 1; level 2 needs 36 XP, then each next requirement grows by
18 XP. Excess XP carries over, and the results screen shows your final level
and total collected XP. Quick Play and Practice start fresh; campaign progression carries between songs.

Campaign and Quick Play songs also scatter **four pickups** across the floor,
with randomized positions and timing from roughly 12% through 82% of the song.
Every song includes one of each kind plus a random fourth. Fly over one to use it:

- **Health** · green cross: restores **50 health**, up to your upgraded maximum.
- **Magnet** · blue horseshoe: draws every existing XP gem toward the ship,
  awarding its XP and upgrades when it arrives.
- **Bomb** · orange charge: sends out a **100-damage** wave over 0.75 song seconds,
  reaching a radius of **25% of the arena width** (nine units in the normal arena).
  Each enemy can be hit once per wave; kills award normal score and XP.

Pickups remain until collected or the song ends. Pause freezes them and bomb
travel; their symbols and damage rings remain visible with effects Off.
Campaign Continue replays the same pickup schedule from the song-entry checkpoint.

Level-ups produce blue-and-gold rising particles and expanding rings timed to
a nearby musical subdivision. Comfort settings soften or disable the
celebration while keeping gems and the XP bar visible. Each new level also
offers **three larger upgrade cards stacked on the right**. Music and gameplay continue
at normal speed while you choose; movement, aiming and dash stay available.
Press **1, 2, or 3** (including the numeric keypad), or click a card, to apply
its effect immediately.

| Upgrade | Effect per selection |
| --- | --- |
| **Power** | +3 to both ends of the damage range; initially 13–17 → 16–20 |
| **Vitality** | +20 maximum health and restore 20 current health |
| **Regeneration** | +2 health restored every 5 seconds of song time, on the next authored beat |
| **Split Shot** | +1 projectile per normal firing beat, up to 7; −10 percentage points of all weapon damage per rank |
| **Downbeat Barrage** | Unlock a 6-projectile outward ring on the accented main beat; subsequent selections add 2, up to 24 |
| **Critical Chance** | +5 percentage points, initially 12% → 17%, up to 100% |
| **Critical Damage** | +0.25× critical multiplier, initially 2× → 2.25× |
| **Ricochet** | +1 bounce per projectile, up to 5; each bounce retains 70% of the previous damage |
| **Pickup Radius** | +25% of the base XP attraction radius, up to 300% total (8 ranks) |
| **Dash Distance** | +0.6 distance per dash, initially 3.6 → 4.2, up to 7.2 (6 ranks) |
| **Wall Bounce** · rare | Shots rebound from one wall without losing damage; the next wall stops them |
| **Homing Shots** · rare | Gently steer toward the closest enemy ahead, up to 30° per second and 30° total |
| **Regenerative Shield** · rare | Block one hit, then recharge after 25 seconds of song time |

Each starting or level-up offer has a **12% chance** of replacing one normal
card with an available special, chosen equally. At most one special appears
per offer. These gold **Rare · Unique** cards have one tier and disappear from
the pool once acquired; restart clears them with the other upgrades.

Wall Bounce reflects at the actual arena boundary, including corners, and
sweeps the remaining travel for enemy hits. It preserves speed and damage,
refreshes enough lifetime to cross the arena, and spends no enemy ricochets.
The normal Ricochet upgrade can still trigger after an enemy hit; it cannot
restore the spent wall rebound. Homing acquires living, unhit enemies ahead
within 14 arena units, preserves speed, and has a total steering budget so it
cannot make a U-turn or orbit a target. Both specials apply to newly fired
fan and barrage shots; hostile fire remains unchanged.

The shield starts charged and absorbs either contact or projectile damage.
Blocking grants the existing brief hit immunity, so simultaneous impacts
cannot immediately take hull health. Later damage does not restart its
25-second recharge. Its timer follows raw song position, including pause and
slowdown, independently of detected beats and visual calibration. A thin
outline shows the available charge and the HUD shows **Ready** or the remaining
seconds. The outline gently follows the beat; comfort settings keep it steady.
See [special upgrade verification](docs/special-upgrades-verification.md).

Card values are color-coded: offense in red, health in green, and utility in
purple. Titles and surrounding prose stay neutral. Pickup Radius increases
the range where gems start moving toward you; they still award XP on arrival.
Dash Distance extends the burst without changing its beat window or duration.

Split Shot widens the normal shot into a symmetric fan around the aim: 12°
more total spread per added projectile, capped at 60°. Barrage fires a full
ring in addition to that fan, only on actual accented bar starts, using the
same main beat as dash and enemy attacks. Split Shot's global damage factor is
90%, 80%, 70%, 60%, 50%, then 40% at ranks 1–6. It applies to the fan, barrage
and critical hits, and combines with Power before the final damage rounding.
Existing shots retain their fired damage when a new upgrade is selected.
Ricochets stop at their impact point,
then launch toward the nearest enemy they have not already hit on the next
beat. Bounce damage follows 70%, 49%, 34.3%, 24.01%, and 16.807% of the
projectile's original fired damage; each impact rounds to a whole number
without carrying rounding error into later bounces.
Each projectile can bounce at most once per authored beat. All shots
retain the existing projectile budget.
See the [balance verification](docs/balance-verification.md) for the scaling
rules and checks.

Regeneration starts five song seconds after acquiring it. Each heal lands on
the first authored beat at or after its due time, then starts the next
five-second interval. Slowdown stretches that interval in real time, pause
stops it, and missing beats never release a backlog of heals.

The live upgrade panel uses larger cards and prominent skill titles, allowing
more arena overlap on narrow screens to keep the text readable. Choices stay
fixed until selected. Selecting applies the stat immediately: the other cards
fade out, while the chosen card highlights, flashes on the next beat, and fades
away over the following beat. Further levels queue behind that confirmation;
the next offer appears after it finishes. Reduced-motion/flash settings retain
the highlight and fade without the pulse. The starting choice uses the track's
tempo for its brief confirmation during the count-in.
Holding a number key or double-clicking cannot spend multiple choices.
Escape and focus loss pause normally and retain the queue. Pause keeps the arena
visible, shows acquired upgrades with ranks and current effects on the left,
and leaves offered upgrades readable on the right. Narrow screens stack the
panels in a scrollable view. Resume to continue choosing. Waiting during live
play grants no damage protection. Finishing or losing a
run closes the panel, and restart clears upgrades and pending choices before
offering a new starting upgrade. The free starting choice does not consume XP
or replace the first earned level-up.
See [XP verification](docs/experience-verification.md) for the gem system and
[upgrade verification](docs/upgrades-verification.md) for the selection flow.

The HUD uses larger health and score values, readable XP and timing labels, and
14 px control hints. Narrow screens wrap controls and move XP below the top
row; upgrade cards scroll within the space between the top HUD and beat panel.
Menu, settings, and results text follows the same readable sizing.

The larger beat indicator sits at the bottom center. The eligible beat's diamond
gains an outline and **Dash ready** appears during a ±150 ms window around any
beat. Press **Space** in that window to dash. Each bar allows one dash, usable
on any of its beats; the next bar resets it. Holding the key, pressing it twice
on one beat, or pressing off-beat never queues another dash. An early press near
the next bar's first beat spends that next bar's dash. The burst follows local beat timing, stays on the play plane and respects
walls/enemy collisions. It does not grant extra damage immunity.
Each dash captures its distance when activated, so choosing an upgrade during
the burst affects the next dash.
Automatic tracks use their actual detected beats and chart bar markers, including
changing meter and inferred bars when downbeats are unavailable. Visual calibration
remains cosmetic: dash input is judged against the current audio clock.

The player ship is a silver-and-blue triangular fighter with swept wings, a raised
cockpit, and twin rear engines. Amber engines signal the actual dash window;
they glow faint cool blue between windows, dim after use, and show a tiny blue
exhaust tip during a dash. Readiness stays steady without a breathing flare, and
engine colors remain below the bloom threshold. Exhaust follows the music clock
and holds when paused. Reduced-effects settings retain the colored engine lights
without plumes.

Local files never upload. Selecting a file automatically runs Beat This! locally
with WebGPU. It detects individual beats and bar starts, including changing tempo.
Detected timing is selected automatically. Preview with the metronome or play
once analysis finishes. **Timing** contains the optional **Manual BPM** control
and first-beat offset. Displayed BPM is rounded; detected timestamps retain their
full precision.
The preview section selector offers 12 seconds from the start, middle or end,
or the full track. Higher clicks mark bar starts.

Analysis also runs **LinkSeg** locally to estimate intro, verse, chorus, bridge,
instrumental, outro and silence sections. The compact bottom progress bar colors
each section and shows the playhead. The import preview adds current/next labels
and a legend to the same section map. Section predictions
also drive the arena transitions below and the section health scaling; enemy
schedules, beat timing and collision rules remain unchanged. If section analysis fails, detected beats
are still playable. See the [LinkSeg evaluation](docs/section-analysis.md)
for measured performance, predictions and remaining listening review.

In **Standard** effects mode, entering a new authored or detected section sends one
shockwave from the center of the arena toward its edges. The floor and grid
change to the new section's colors as the ring passes, leaving the new theme
behind it. The front lifts nearby vertices into a smooth ridge, then lets them
settle as it passes. Floor, walls, actors, shots and particles share this
deformation; health bars and damage numbers follow their raised anchors.
Camera orientation and physics stay steady. Perimeter and background colors blend to match the section
timeline: blue for intro, green for verse, gold for chorus, violet for bridge,
cyan for instrumental, rose for outro and dark slate for silence.
These are preferred themes: when the next theme repeats or is too similar,
the arena chooses a contrasting palette. Every consecutive section gets a
distinct color, including repeated labels; replaying uses the same choices.

Behind the arena, **960 small, bright stars** surge outward on each beat across
three depth layers (480 with Low graphics), settling between beats. They travel
2.5 units per beat, averaging five units/second at 120 BPM. Each section
shockwave adds up to 120 units/second and stretches them into long hyperspeed
streaks. Integrated travel keeps the stars moving forward when the boost ends.
The starfield follows the music clock through pause and slowdown, while the
camera keeps its normal orientation and player follow.

One beat before an eligible boundary, a soft light gathers at the map center
and the view gently zooms in, reaching **5% zoom** at the section start.
The buildup is capped at 0.6 song seconds and skips gaps or overlapping waves.
The outgoing wave starts at the authored or predicted boundary on the raw music clock,
independent of visual calibration. Its radius follows an **ease-in-out curve**:
a slow launch, a fast sweep through the arena, then a soft arrival at the edges.
The color wipe and vertex ridge follow that same eased front. The zoom returns
to normal over the first actual beat; aiming and health-bar projection follow
the changing lens. The HUD remains steady.

Waves travel **30% faster**: the previous four-beat window now takes about
3.08 actual beat intervals, following tempo changes. Existing slow-song and
gap limits apply before this acceleration. Each wave finishes before the next section or
an unusable beat interval. Fragments shorter than 0.65 song seconds and
boundaries inside detection gaps use a short color fade. Pause and slowdown
freeze or stretch the effect with the music. The first section establishes its
colors during count-in without an entrance effect.

The shockwave is cosmetic: movement, dash directions, pointer aiming and
collision rules keep their normal behavior. **Calm** uses a subtler ring, lower ridge and
weaker starfield boost, softer buildup and **1% zoom**. **Off**, reduced flashes and reduced motion
disable the buildup/zoom, keep the stars static and use a simple fade between section palettes.
Tracks without section data, such as the dojo,
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

The neon presentation uses dark ship/enemy faces with luminous geometric edges,
thin glowing arena rails, bright projectile cores and blue XP gems. Selective
HDR bloom adds soft halos around the bright geometry while preserving its sharp
edges. Projectile trails grow over a short fraction of the local beat and stop
with the music. Shallot's native vignette subtly frames active gameplay, switching
off for menus, the starting upgrade/count-in, pause/settings, and results.
Section transitions briefly add subpixel color separation near the screen edges
through the existing chromatic shader; this prerelease does not yet include the
native chromatic aberration effect. The DOM HUD remains crisp.

Bloom intensity follows the shared musical pulses and section envelope.
**Calm** softens the glow and shortens trails; **Off** bypasses postprocessing and
hides trails. Reduced flashes and OS reduced motion keep a gentle, steady glow
without trails or color separation. Low graphics uses smaller bloom targets,
three bloom passes instead of four, and up to 64 trails instead of 192.
The native vignette adds one pass during gameplay. Pools and GPU
targets are reused through play and retry. See
[neon visual verification](docs/neon-visuals-verification.md).

The arena's floor patterns, bar ripples, perimeter lights, death shards and
damage-number envelopes follow the same music clock. Section transitions change
floor colors behind an outward-moving ring; physical map transforms, play plane, collision
boundaries, camera orientation and aiming remain stable. Deaths and scores resolve immediately;
larger death accents wait at most 100 ms for a nearby sixteenth-note subdivision.
When no suitable subdivision exists, a small local dissolve confirms the kill.
Long detection gaps settle the decoration without inventing extra beats.

In **Settings → Visual effects**, choose **Standard** for the full effect set,
including section shockwaves, **Calm** for softer motion, or **Off** for a stationary
arena with essential feedback and section color changes. Graphics detail
controls rendering cost independently. **Reduced flashes** and the device's
**reduced-motion** preference disable travelling decoration and section rings
while keeping small local fades and a stationary spectrum border.

The music stage adds spectrum bars outside the walls, corner laser fans,
flowing aurora ribbons and particles, expanding geometric echoes, and morphing
wireframes behind the arena. Intro, verse, chorus, bridge and outro arrangements
crossfade between different combinations. Actual audio energy controls their
strength, so a section label alone never forces a large accent.
Spectrum accents, laser sweeps, aurora travel, particles, geometry and stars
share the beat's surge-and-settle timing. Floor light and bloom brighten on the
same beat, with stronger contrast between the accent and the space after it.
Calm softens the motion. Audio features shape intensity and color; the authored
beat timestamps control the rhythm.

Analysis measures loudness/bass, 16 FFT bands, mids/highs, transients, and sustained
energy rises/falls at 20 Hz. Uploaded tracks share their analysis worker; the demo
and manual-BPM tracks use a small DSP-only worker with no model download. The
decoded local file retains its visual curves for retries. Dojo and unavailable
metadata use a neutral beat-driven fallback. These curves never change beat
timestamps or gameplay. The stage reuses 336 nonphysical meshes, reduces work
at Low detail, and follows the song clock through pause, seek and retry. See
the [music stage verification](docs/music-stage-verification.md) for details.

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
bunx playwright test --config playwright.dev.config.ts
bun run build
bun run preview
```

The tests cover the actual Shallot solver, fake and real Web Audio clocks,
swept collision/filtering, deterministic combat, settings corruption, production
startup/error handling, local files, pause and loading cancellation, and repeated
retries. Browser tests run against the production build; the separate dev config
checks the real analysis worker's dependency loading, runtime module serving,
and actionable errors under Vite dev, without requiring downloaded models. The original welcome
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
| `src/session/` | Menu/loading/play/pause/results, live upgrade selection, audio/entity/listener ownership |
| `src/music-visuals/` | Floor shader, bounded musical effect queues, pooled shards/rings and comfort controls |
| `src/music-stage/` | Spectrum perimeter, laser fans, auroras, geometric echoes and section arrangements |
| `src/section-effects/` | Section anticipation, eased waves, subtle camera zoom and dark palette transitions |
| `src/shockwave/` | Shared vertex displacement, corrected normals and subdivided arena surfaces |
| `src/starfield/` | Continuous music-clock travel, integrated section speed boosts and pooled background stars |
| `src/neon/`, `src/neon-trails/` | Selective HDR bloom, geometric emission, section color separation and pooled musical projectile trails |
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
