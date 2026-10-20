# Rare single-tier upgrades

Implemented 2026-10-20 against the installed Shallot 0.10.1-next.2.

- Each offer has a 12% chance of containing one available special. The three
  specials have equal probability; offers remain distinct, deterministic from
  their own seed, and stable until selection. Acquired specials never recur.
- Wall Bounce reflects once at the arena's inner face, retaining damage and
  speed. Sweeps resolve enemy impacts before the wall and on the reflected
  segment. A corner reflects both velocity axes using one charge. The second
  wall retires the projectile; normal enemy ricochets remain independent.
- Homing Shots makes a bounded correction toward the nearest eligible enemy
  ahead within 14 units. Both the angular speed and total correction are capped
  at 30 degrees (per second / per projectile). Speed is unchanged; dead,
  friendly, previously hit and behind-the-shot targets cannot attract it.
- New player projectiles capture both weapon specials, including fan and
  barrage fire. Existing shots and hostile projectiles are unaffected.
- Regenerative Shield starts ready, absorbs a full contact or projectile hit,
  then recharges after 25 raw song seconds. Blocking shares the normal hit
  immunity; later unshielded damage does not postpone recharge. Pause holds
  the timer, and restart clears the upgrade. The HUD exposes charge/countdown;
  a bounded 12-segment outline follows the beat and breaks on absorption.
  Comfort settings keep the charged outline steady.
- Special cards use a gold border and `Rare · Unique` label instead of ranks,
  including accessible names and the selected confirmation.

## Checks

- 382 CPU tests passed across 54 files, including 74,019 assertions.
- New checks exercise all four walls, corner reflection, reflected-segment
  collision, targets behind a wall, enemy ricochet interaction, normal/hostile
  shot behavior, homing acquisition/turn bounds, firing snapshots, shield
  contact/projectile absorption, shared immunity, held clocks and exact recharge.
- A deterministic 5,000-seed sample verifies rare-offer frequency, maximum one
  rare card, and offer stability. Repeated selections verify single-tier
  exclusion and fresh-run reset.
- Production build passed in the isolated `output/special-upgrades-dist`.
- `bun check` passed across 387 files.
- A real Chromium Practice run selected Regenerative Shield using number key
  3. Across 803 live samples, the first block retained all 100 hull health.
  Its charge was due at 35.4987755s and the first observed ready frame was
  35.5014966s. A one-second real pause held song position and the countdown.
  Movement, aiming and dash used normal keyboard/pointer events throughout.
- Separate seeded starting offers selected Wall Bounce and Homing Shots through
  keys 2 and 1. The reflected shot retained 16 damage and reversed its X
  velocity at the wall. The homing shot bent by 0.5° in one fixed step while
  retaining speed 32, confirming the 30°/second limit in real play.
- Desktop 1280×800 and mobile 390×844 screenshots confirm readable rare labels
  and descriptions; gameplay screenshots confirm the shield outline and HUD.
- All eight selected browser regressions passed across the initial and focused
  follow-up runs: damage/comfort/retry, fresh starting offers, desktop/mobile
  selection, uninterrupted upgrades, queued choices, pause and enemy ricochet.
  Two fixed offer seeds were refreshed for the new rare-card RNG consumption;
  the existing behavior assertions remain intact.

Ignored evidence: `output/special-upgrades-unit.log`,
`output/special-upgrades-build.log`, `output/playwright/special-shield-samples.txt`,
`output/special-upgrades-browser.log`, `output/special-upgrades-followup.log`,
`output/playwright/special-shots-witness.txt`, and the
`output/playwright/special-*.png` screenshots.
