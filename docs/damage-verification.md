# Player damage and enemy health feedback

Implemented against Shallot 0.10.0 using Bun 1.4.3.

This records the original damage-system milestone. The subsequent
[upgrade milestone](upgrades-verification.md) adds gameplay modifiers and changes
number timing to an immediate stationary appearance, followed by a one-beat
pop/rise/fade beginning on the next authored beat.

## Behavior

- Normal shots roll an inclusive integer range of 13–17. Existing critical hits
  remain a 12% chance at 2× damage. Enemy health remains 24.
- Each enemy keeps its spawn-time `maxHealth` independently of current health.
  A 32 × 5 px bar follows its rendered body and immediately shows health loss.
  Dead enemies lose their bars, while their final damage number remains visible.
- Damage numbers show rolled damage on every hit, including overkill. Gold,
  larger numbers identify critical hits. Kill score remains in the HUD.
- Numbers pop immediately, settle for a quarter beat, then rise and fade within
  1.5 authored beats. The envelope uses the shared calibrated music clock and
  follows changing beat intervals. Pause freezes it. Detection gaps use the
  timeline's quiet fade, without synthesizing beats or reviving expired feedback.
- Effects Off and reduced motion retain bars and damage text, with stationary
  number fades. Feedback retains its existing 100-number cap.

## State and future modifiers

`src/player-stats/index.ts` owns the pure `PlayerStatsState`. Each combat session
creates its own state, reset on retry, dojo reset, track replacement, and menu
return. XP levels do not currently change it.

`base` and `effective` contain `damageMin`, `damageMax`, `criticalChance`, and
`criticalMultiplier`. Readonly snapshots prevent accidental direct stat edits.
Named modifier sources replace by ID; removal restores the remaining sources.
Stats resolve in stable ID order as `(base + sum(add)) × product(multiply)`.
Damage rounds to integer values; critical chance clamps to 0–1. Invalid values
are rejected before replacing the existing modifier/effective snapshots.

For a future upgrade, the caller can use:

```ts
import { setPlayerStatModifier, removePlayerStatModifier } from "../player-stats";

setPlayerStatModifier(combat.playerStats, "weapon-power", {
    add: { damageMin: 3, damageMax: 3 },
});
removePlayerStatModifier(combat.playerStats, "weapon-power");
```

This API is available without granting any upgrade in gameplay. The existing
seeded combat RNG supplies both roll samples. Each projectile captures its
damage and critical flag when fired, so later modifiers affect subsequent shots.
Cosmetic rendering never consumes gameplay randomness.

`metrics` tracks `shotsFired`, `hits`, `criticalHits`, `totalDamageDealt`, and
`lastHitDamage`. A shot counts only when created; a hit counts once when it
removes enemy health. Dealt damage is actual health removed, excluding overkill.
Misses and enemy fire never inflate damage totals. For example, two 17-damage
hits kill a 24-health enemy: numbers show 17 and 17, total damage dealt is 24.

`createCombat(seed, combatTuning, playerStats)` accepts independent base overrides
for deterministic tests. Damage values are no longer duplicated in arena/combat
tuning. The opt-in read-only browser inspector includes stats, metrics, enemy
health capacities, projectile damage, and the rendered health-bar count.

## Verification

- `bun test`: 187 passed / 9,830 assertions across 22 files. New checks cover
  modifier composition/replacement/removal and validation, seeded damage ranges,
  projectile snapshots, critical counts, actual damage versus overkill,
  same-tick kills, isolated runs, and musical number lifetimes at 20–300 BPM.
- `bun test ./tests/player.node.ts`: 4 passed / 660 assertions against the
  real physics implementation.
- `bun check`: no errors in 303 files.
- `bun run build`: passed; the existing large-bundle advisory remains.
- The two new production browser checks passed. Ordinary aiming and keyboard
  controls verified all three enemy bars, partial health loss, hit/kill numbers,
  damage totals, beat-relative animation, frozen pause, reset, and effects
  Off/reduced-motion readability.
- `bunx playwright test`: all 40 production browser checks passed in 4.1 minutes,
  including ten retries, enemy/XP/dash behavior, local files, audio lifecycle,
  visual calibration, viewport changes, and the full 72-second demo win
  (5,988 points / 57 kills / 60 health).
- Both damage browser checks passed again after the compositor optimization
  (17.4 seconds); type checking and the production build also passed.
- Reviewed screenshots: `output/playwright/damage-healthbars-and-numbers.png`
  and `output/playwright/damage-reduced-motion.png`.

## Dense-scene performance

The final production run used the existing 200-enemy / 500-projectile refill
fixture, 3 seconds of warmup, and 600 measured frames at 1200 × 924 / DPR 1.
On Apple M1 Max / 64 GiB / Chromium 156.0.8078.4, it averaged **60.002 FPS**:
16.666 ms mean frame interval and 16.670 ms at both the 95th and 99th percentiles.
Every live enemy had a rendered health bar (197–200 after each fixed step);
feedback stayed at its cap of 100. Menu return cleared all session entities,
health bars, and sounds. No browser errors occurred. This is a measured desktop
result, not a guarantee for every device.

The initial implementation averaged 19.356 FPS in the same dense fixture.
Profiling isolated painting/compositing: hiding bars restored 60 FPS while
keeping combat, stats, projection calculations, and DOM updates active.
Caching each small moving bar with `will-change: transform` restored the frame
budget with the bars visible and their appearance preserved. These surfaces
are bounded by the enemy population and removed with their enemies. The
stress harness now also verifies bar counts and waits for DOM cleanup.

See the [final measurement](damage-performance-2026-10-20.json). Diagnostic
probes remain in the ignored `output/` directory; production code contains no
profiling hooks.
