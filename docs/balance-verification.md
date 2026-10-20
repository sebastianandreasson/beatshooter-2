# Section and weapon balance

Implemented 2026-10-20.

## Rules

- Section zero is baseline. Each later section compounds enemy maximum health
  by 1.1, derived from the enemy's original health and rounded to whole HP.
  Neon Circuit's progression is **24 → 26 → 29 → 32 → 35 → 39 HP**.
- Living enemies retain their health percentage, rounded to whole HP; dead
  enemies remain dead. Pending arrivals and subsequent waves receive the same
  capacity. Identically labelled adjacent sections still count separately.
- Difficulty follows raw accepted song position in the fixed combat system,
  not the visual section effect. Off/reduced effects, calibration, offbeat
  boundaries and missing beat detections do not change it. Held observations
  cannot stack boosts. Skipped boundaries are included; a fresh run resets
  scaling. Dojo/absent section data stays at baseline.
- Each ricochet retains 70% of the previous bounce's damage: **70%, 49%, 34.3%,
  24.01%, 16.807%** of initial fired damage. Calculation uses initial damage and
  completed impacts so rounding cannot accumulate. The next beat still releases
  the bounce; a duplicate beat cannot reduce damage again.
- Split Shot applies a global factor of **90%, 80%, 70%, 60%, 50%, 40%** at
  ranks 1–6. This is a ten-percentage-point penalty per rank, applied to all
  player projectiles, including barrage and critical hits. Base damage and
  critical multipliers combine before the final integer rounding.
- Projectiles retain the stats captured when fired. Later upgrades affect new
  projectiles; bouncing shots decay from their own initial damage.
- Split Shot and Ricochet cards explain their penalties. Power previews the
  real noncritical damage range after the global damage factor.

## Checks

- Bun 1.4.3: **372 tests passed**, 52,807 assertions across 53 files.
- `bun check`: passed across 384 files.
- Production build: passed, 476 modules, isolated in `output/balance-final-dist`.
- New CPU coverage checks section boundaries/repeated labels, live/pending/new
  enemies, wounded/dead targets, skipping/duplicate observations, no-section
  fallback, all three enemy types, numeric bounds, raw-clock integration,
  effects Off and pause. Weapon checks cover all six Split Shot ranks, modifier
  removal, fractional critical rounding, fan/barrage consistency, all five
  ricochets and changes to player stats while a shot is in flight. The
  50-damage case checks exact half rounding: its second bounce deals 25 HP.
- A Chromium demo run selected Split Shot through the real starting menu.
  Forty-two live frame samples show four existing enemies changing from
  24/24 HP before 8s to 26/26 HP at 8.00263s, with two projectiles per beat and
  a 0.9 damage factor. Both new penalty descriptions were visually inspected.
- All 12 selected browser scenarios passed across the initial and focused
  follow-up runs: damage, comfort settings, section transitions, viewport
  resizing, starting/live/queued upgrades, ricochet and full-song completion.
  The final ricochet check observes the real projectile retaining its initial
  damage while waiting, then losing 30% on its next-beat release.
- The original automated playthrough died late in the song. The updated test
  uses a wider route, prioritizes crowd-control/damage upgrades and chooses
  healing when wounded. It completed all 72 seconds with **65 health, 65 kills
  and 6,788 points**, observing all six sections and five transitions. Every
  action uses real keyboard/pointer input; health, clocks and balance values
  are unchanged by the test.

Ignored evidence: `output/balance-unit.log`, `output/balance-final-build.log`,
`output/balance-browser.log`, `output/balance-final-browser.log`,
`output/balance-playthrough-browser.log`,
`output/playwright/balance-live-sections.json`,
`output/playwright/balance-upgrade-cards.png`.
