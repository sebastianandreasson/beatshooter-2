# Level-up upgrades and musical combat timing

Implemented against Shallot 0.10.0 with Bun 1.4.3.

## Current selection behavior — uninterrupted play

A full-screen **Start of run upgrade** choice precedes each run, including
retries and dojo resets. Music stays stopped until a choice is made. Selecting
applies one free upgrade, then starts the normal count-in. XP and level remain
unchanged. The screen explains the later side panel, shortcuts and queue.
Failed audio startup retains the selected perk and exposes a start retry; it
cannot award the perk twice.

Each new run, restart, and dojo reset draws a fresh browser-random seed for
the upgrade stream. Offers contain three distinct options and stay fixed until
selected; later level-up offers continue that run's stream. Spawn and damage
randomness stay independent. The session regression reproduces the old repeated
starting set, then verifies new runs with controlled entropy. The browser fixture
controls entropy only in tests so combat scenarios remain reproducible.

Random-offer verification: 18 session/upgrade unit tests and four browser checks
passed, covering menu starts, restart, stable pending choices, starting-card
selection at desktop/phone widths, and dash/pause/retry.

Level-ups display three enlarged cards on the right while the session stays in
`playing`. Neither earning nor selecting an upgrade calls the audio transport,
changes simulation speed, grants protection, clears movement, or cancels dash.
The catalog and musical combat effects below are unchanged.

The live panel is up to 560 px wide, with 30 px skill titles (27 px on narrow
screens), larger effect details and descriptions, and scrolling on short
viewports. Start-of-run cards use 34 px titles, with a stacked layout at smaller
widths. Readability takes priority over keeping the panel outside the arena;
the live panel reserves space for the bottom beat/dash indicator. Keyboard
selection scrolls the chosen card into view before confirming it.

Main-row and keypad keys 1–3, or a card click, apply the offered stat immediately.
The displayed cards remain briefly: unchosen cards fade out, the selected card
gets a gold highlight and one flash on the next authored beat, then fades over
the following beat. During confirmation all three cards are disabled, and
queued offers wait until it finishes. Live animation samples song time, freezes
with pause, and fades quietly through detection gaps. Reduced flash, reduced
motion and effects-off settings suppress the pulse and scaling. The pre-music
choice uses a tempo-based menu envelope during count-in. Retry, quit and results
discard old confirmation state.
The live side panel does not steal focus, trap Tab, dim the arena, or make the
HUD inert. The initial full-screen choice uses modal focus handling.
That focus handling stays active through its retained confirmation, and a
deliberately focused live card transfers focus to the next queued offer.
Space remains dash when a card has focus. The current offer remains fixed as
additional levels queue; a counter shows how many offers follow it. Each choice
spends one level. Held keys, double clicks and stale offer IDs are guarded.
Escape and focus loss use normal pause and retain all choices. Pause leaves the
arena and HUD visible without a full-screen dim or blur. Acquired upgrades appear
on the left with ranks, current numeric effects and full descriptions; offered
cards remain readable on the right with selection disabled until resume. The
pause controls sit between them. Long builds and offers scroll, and narrow
screens stack the panels inside the arena area below the upper HUD.
Selection is unavailable during pause/results; retry resets the run.

Pause layout verification (2026-10-20):

- All 471 unit tests passed; type checking and the production build passed.
- The two existing live-upgrade browser checks passed, including frozen clocks,
  unchanged offers, retained confirmation, blocked selections and normal resume.
  The layout check passed again after the final mobile scroll adjustment.
- Reviewed desktop and narrow screenshots at 1280×800 and 390×844:
  `output/playwright/upgrades-paused-1280.png` and
  `output/playwright/upgrades-paused-390.png`.
- The acquired-build regression covers all 13 upgrade types, current effects,
  owned ranks and preserving combat/offer state while reading the build.

Readability and confirmation verification:

- Full unit suite: 329 tests passed. The seven new feedback tests cover exact
  and future beat boundaries, variable tempo, held clocks, gaps, and menu timing.
- Type checking and the production build passed.
- Nine upgrade/dash browser checks passed. All five upgrade checks passed again
  after the final focus and HUD-clearance adjustments.
- Browser checks cover immediate stat application, retained disabled cards,
  next-beat flash and fade, ignored extra selections, paused confirmation,
  queued-offer reveal, retry cleanup, fullscreen focus handling, and readable
  cards above the beat indicator at 1280×800, 390×844 and 1024×600.
- Reviewed the live/start screenshots and
  `output/playwright/upgrade-selection-feedback.png`.

Earlier uninterrupted-play verification:

- Shared project: `bun test` passed 284 tests / 29,238 assertions across 39 files;
  `bun check` and the production build passed.
- All 16 affected browser checks passed against an isolated production build
  while the other agent was finishing the shared shockwave implementation.
  Coverage includes normal-speed audio/simulation and held movement with cards
  open, card clicks, number/keypad shortcuts, stable queued offers, held-key
  suppression, Escape, restart, XP collection, dash, and existing menu/import flows.
- The full 72-second demo completed through ordinary movement and aim with live
  upgrade selection: 6,788 points, 65 eliminations, 50 remaining health.
- Reviewed the live panel at 1280×800, 390×844 and 1024×600. The three cards are
  stacked on the right with visible shortcuts; the arena has no modal overlay.
  Screenshots: `output/playwright/upgrades-live-1280.png`,
  `output/playwright/upgrades-live-390.png`, and
  `output/playwright/upgrades-live-1024.png`.

The real-game queue check keeps playing without selecting the first offer,
earns another level through combat and pickups, then selects successive choices.
No test API grants XP or alters the game state. Session tests separately cover
several levels from one pickup, stale offer rejection, pause/focus-loss retention,
and track completion taking precedence.

## Utility upgrades and numeric colors

| Upgrade | Per selection | Limit |
| --- | --- | --- |
| Pickup Radius | +25% of base XP attraction range | 300% total / 8 ranks |
| Dash Distance | +0.6 distance, from a 3.6 baseline | 7.2 total / 6 ranks |

Numeric effects use explicit catalog text parts: offense values are red,
health values green, and utility values purple. Arrows, units and surrounding
sentences remain neutral, including unchanged timing such as the regeneration
interval. The 20-health restoration in Vitality's description is also green.
Plain-text descriptions and accessible card labels retain the complete copy.

`pickupRadiusMultiplier` and `dashDistance` are fractional effective player
stats. Pickup Radius scales the XP magnet's base range without changing
physical collection contact or mutating its tuning. A first rank reaches
4.375 units instead of 3.5. Dash Distance preserves the existing duration
and ±150 ms beat window; the accepted dash captures its distance and speed
until that burst finishes. Caps remove fully upgraded utility cards from the
offer pool, and retry restores both defaults.

Verification for utility upgrades and numeric colors:

- `bun test`: 347 tests / 50,804 assertions passed.
- Five real-physics checks passed, including maximum-distance dashes into a
  corner at the fastest supported tempo.
- Type checking and production build passed.
- All 13 affected browser checks passed: five upgrade, two damage, four dash
  and two XP checks. These include both utility choices and retry resets,
  a real 4.2-distance dash, numeric-only computed colors, and existing
  selection feedback, queued offers, barrage and ricochet behavior.
- Reviewed desktop/phone starting cards, the earned health card in
  `output/playwright/upgrade-health-values.png`, and selection feedback.

## Original implementation record

The following measurements describe the earlier pause-based implementation.
The later [spawn and pacing update](spawn-pacing-verification.md) shortened its
slowdown and raised XP requirements to 36 initially, +18 per level. The selection
pause and slowdown are now removed; these measurements remain historical.

## Gameplay and ownership

Each earned level queues one choice from three distinct, eligible upgrades.
Offers use a separate seeded random stream, remain stable while displayed, and
exclude capped stats. Several levels earned in one pickup keep the game paused
until every choice is made. Runs reset ranks, modifiers, pending choices, and
transport speed.

`src/upgrades/index.ts` owns the catalog, offer state, ranks, and applications.
Each rank replaces one named `upgrade:<id>` modifier in `PlayerStatsState`.
The catalog is the place to adjust descriptions, balance, eligibility, and
rank effects. Normal and barrage projectiles capture damage, critical outcome,
and bounce budget when fired.

| Upgrade | Per selection | Limit |
| --- | --- | --- |
| Power | +3 minimum and maximum damage | No rank cap |
| Vitality | +20 maximum health and restore 20 health | No rank cap |
| Regeneration | +2 health per five song seconds | No rank cap |
| Split Shot | +1 projectile in a symmetric fan | 7 projectiles, 60° total spread |
| Downbeat Barrage | First selection unlocks 6 radial shots; later selections add 2 | 24 radial shots |
| Critical Chance | +5 percentage points | 100% |
| Critical Damage | +0.25× multiplier | No rank cap |
| Ricochet | +1 bounce | 5 bounces per projectile |

The ordinary fan fires on the existing firing beats. Barrage is additional fire
on explicitly authored downbeats, including irregular or changing meter.
Ricochets hold at their impact position until the next actual beat, then target
the nearest living enemy that projectile has not hit. Each hop spends one bounce;
no eligible target retires the projectile. Waiting does not spend flight lifetime,
and the existing 500-projectile cap still applies.

Regeneration waits five seconds of song time, heals on the first actual beat at
or after that deadline, then starts another five-second interval. Pauses stop the
clock; slowdown stretches it; detection gaps cannot release a backlog of heals.

Damage numbers appear immediately at rest. The next authored beat starts their
pop, rise, and fade; the following beat expires them. Exact-on-beat hits start
immediately. Pause retains their pose, reduced motion uses stationary text, and
detection gaps keep the existing quiet fade without reviving old feedback.

## Audio, simulation, and selection

The transport automates source playback rate from 1× to 0.12×, fades the final
quarter of the transition, and stops at a nearby authored quarter-beat
subdivision. Its playhead integrates that exact playback-rate curve and uses
the inverse curve to schedule metronome clicks. Missing detections and song
tails use a short bounded transition. Track completion takes precedence.

The simulation follows the transport speed through Shallot's time scale.
Physics retains the engine's fixed-step resolution; visuals and card entrance
poses use music position directly. Crossing the stop boundary consumes its
beat commands once before freezing. The player is protected and movement/dash
input is cleared during the transition. Selection becomes available after the
pause, by card click or keys 1–3.

The dialog traps focus, makes the HUD inert, blocks Escape from bypassing the
choice, and stays readable at desktop and 390px mobile sizes. Reduced-motion
settings remove entrance travel. Paused cards use no wall-clock animation.
After the final choice, music resumes immediately at normal rate from its retained
position. This skips the ordinary 40 ms resume lead-in, preventing repeated
choices from adding unaccompanied physics time while music remains held.
An audio-resume failure preserves the applied upgrade and offers an explicit
playback retry. Focus loss, double clicks, repeated keys, and stale async work
cannot duplicate the award or silently resume a replaced run.

## Verification

- `bun test`: 223 tests passed, 10,582 assertions across 26 files.
- `bun test ./tests/player.node.ts`: 4 real-physics tests passed, 660 assertions.
- `bun check`: no errors in 310 files.
- `bun run build`: passed, with the existing engine bundle-size advisory.
- `bunx playwright test`: all 43 production browser checks passed in 4.8 minutes,
  including a complete 72-second demo with upgrade choices (6,788 points,
  65 eliminations, 65 health).
- After the immediate-resume correction, all 7 affected browser checks passed
  again in 2 minutes. They include the measured audio playhead, in-game music
  versus simulation advancement, both upgrade checks, and another full demo win
  (6,888 points, 66 eliminations, 55 health).
- Focused production browser checks verified damage-number beat boundaries,
  XP pickup and upgrade pause, responsive cards, normal-rate resume, radial
  downbeat fire, and a real impact held until the next-beat ricochet.
- Real Web Audio tests measure a generated tone's pitch falling during slowdown,
  exact retained pause position, normal pitch on resume, and unique beat delivery.
- Reviewed in-game screenshots:
  `output/playwright/upgrades-game-desktop.png` and
  `output/playwright/upgrades-game-mobile.png`.

The ordinary-play browser checks earn XP through keyboard movement, pointer
aiming, and gem pickups. Their inspector only reads state. The ricochet check
allows several early enemies to gather before aiming, so a second target exists.
Unit and session tests cover every upgrade, caps, modifier snapshots, variable
beat intervals, 20–300 BPM feedback, several queued levels, permission recovery,
focus races, and track completion.

## Dense-scene performance

The production fixture refills 200 enemies and 500 projectiles before each fixed
step, retaining real physics, combat, health bars, damage numbers, XP drops, and
audio. Its XP threshold is raised to 1,000,000 only in this explicit profiling
mode so a selection dialog cannot interrupt the measurement.

`--upgraded` additionally applies 7 normal projectiles, 24 barrage projectiles,
and 5 bounces per projectile. The fixture creates individual shots independently
of beat-fired volleys to maintain density; ordinary firing cadence is covered by
the gameplay tests. The upgraded measurement confirms actual waiting ricochets
and projectiles that hit multiple enemies, rather than only checking stat values.

On Apple M1 Max / 64 GiB / Chromium 156.0.8078.4, at 1200 × 924 / DPR 1, each run
used 3 seconds of warmup and 600 measured frames:

| Fixture | Average FPS | Mean frame | p95 / p99 | Maximum frame |
| --- | ---: | ---: | ---: | ---: |
| Standard | 60.002 | 16.666 ms | 16.670 / 16.670 ms | 16.670 ms |
| Maximum upgrades, first run | 58.444 | 17.110 ms | 16.670 / 16.670 ms | 283.325 ms |
| Maximum upgrades, repeat | 60.002 | 16.666 ms | 16.670 / 16.670 ms | 16.670 ms |

The first upgraded run had one isolated long frame; it did not recur in the
repeat. Its cause was not established, and both measurements are retained.
Up to 500 simultaneous waiting ricochets and 500 multi-target projectiles were
observed. Every live enemy had a health bar, damage feedback stayed capped at
100, and returning to the menu cleared session entities, health bars, and sounds.
No browser errors occurred. These are measured desktop results, not a guarantee
for other hardware.

See the [complete measurements](upgrades-performance-2026-10-20.json).
