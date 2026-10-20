# Experience drops and levels

Implemented against Shallot 0.10.0 with Bun 1.4.3 on 2026-10-20.

This records the original XP foundation. [Upgrade selection](upgrades-verification.md) was added later, and the [spawn and pacing update](spawn-pacing-verification.md) raises requirements to 36 initially, +18 per level; earlier measurements below remain historical.

## Behavior

Each enemy archetype drops one blue gem worth 10 XP at its death position.
Damage alone grants nothing, and duplicate hits cannot create duplicate drops.
Gems persist until collected or the run ends. Player proximity within 3.5 units
latches attraction; they start at 14 units/second and accelerate toward the
player. Swept magnet and pickup checks handle dashes and prevent tunneling or
overshoot. XP is awarded once on arrival within 0.65 units, not when attraction
starts. Death/paused sessions cannot keep collecting.

Runs start at level 1 with 0 XP. The first requirement is 30; each later
requirement rises by 15. Overflow carries through any crossed levels and total
collected XP is tracked separately. Levels do not change health, damage,
movement, scores or combat RNG, and no upgrade selection interrupts play.
Retry, dojo reset and changing tracks start fresh progression.

The HUD shows level, current XP, and the next requirement in an accessible
progress bar. Results include final level and total XP. Blue faceted gems remain
visible with visual effects Off and with reduced motion; their optional idle
movement follows musical phase.

Level-ups enter the existing bounded effect queue. A nearby authored
sixteenth-note subdivision schedules the celebration with at most 100 ms of
delay; otherwise it uses a small local effect. Blue/gold rising particles and
two rings follow a two-beat envelope, capped at two seconds. Calm, Off, reduced
flashes and OS reduced-motion settings retain their existing meaning. There
are no full-screen flashes or camera movement.

At most 512 gem entities exist. Further drops merge their value into the
nearest existing gem, preserving XP without automatically granting it. Gems
use shared geometry/materials and no physics bodies. Celebrations reuse the
existing 256-shard/8-ring pool, prioritizing level-ups over ordinary decoration.

## Verification

- `bun test`: **168 passed / 9,241 assertions**. Includes death/drop integration,
  swept attraction and pickup, XP conservation/carry, multi-level collections,
  reset/defeat behavior, bounded particle ownership and comfort modes.
- `bun test ./tests/player.node.ts`: **4 passed / 660 assertions**, exercising
  real Shallot movement, walls, dash stopping and pause/resume handling.
- `bun check`: passed across **299 files**.
- `bun run build`: passed with the existing upstream bundle-size advisory.
- Focused production Chromium checks: **2 passed**. Ordinary pointer/keyboard
  gameplay produced a distant gem without remote XP, attracted and collected
  gems, reached level 2, and displayed a music-timed celebration. Reduced-motion
  collection, frozen pause poses and complete restart cleanup passed.
- Desktop 1280×800 and narrow 390×844 layouts keep the XP strip separate from
  health, score and beat timing. Native progress values and its accessible label
  match the run state.
- Screenshots inspected:
  `output/playwright/experience-first-drop.png`,
  `output/playwright/experience-level-up.png`,
  `output/playwright/experience-mobile-hud.png`.
- A complete 72-second demo run finished with **60 kills / 6,288 score / 35
  health**. The reviewed results screen correctly showed **level 4 / 180 total
  XP** from collected gems; uncollected floor gems did not count.
- Full production browser regression: **38 passed in 3.8 minutes**, including
  the demo playthrough, enemy attacks, XP flow, dash, ten live retries, imported
  audio, comfort/calibration modes, settings, loading and startup recovery.
