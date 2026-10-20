# Level-up upgrades and musical combat timing

Implemented against Shallot 0.10.0 with Bun 1.4.3.

This records the original upgrade implementation. The later [spawn and pacing update](spawn-pacing-verification.md) shortens slowdown to approximately 180–250 ms and raises XP requirements to 36 initially, +18 per level; earlier measurements below remain historical.

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
