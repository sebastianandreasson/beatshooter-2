# Campaign encounter verification

Implemented the six presets in `playlist-run-plan.md`. Quick Play uses its
existing combat rules; a campaign configures the current combat state with
`configureEncounter`. The normal beat, physics and presentation loops then
own encounter timing. `stopEncounter` clears warnings and queued strikes before
settlement. The run layer commits completion rewards separately.

## Automated evidence

With Bun 1.4.3:

```sh
bun test ./src/encounters ./src/hazards ./src/combat ./src/enemies
```

2026-10-20: **99 tests passed, 34,395 assertions**. This includes the existing
Quick Play combat, enemy, ricochet, wall-bounce, homing and shield regressions.
New checks cover:

- Seeded three-choice maps, distinct consecutive sets, early introductions,
  completion percentages, captured reward caps and elite-kill eligibility.
- Bounded stage/normalized-song health and speed, preserving wound fractions
  across small capacity changes without rounding drift. Comparable spawn budgets at
  60, 120 and 240 BPM release only on downbeats; unsupported intervals discard
  accumulated pressure and pending arrivals.
- Weaker, doubled Swarm Nest enemies sharing an ordinary wave's XP budget;
  fixed marksman muzzle/aim warnings; alternating three-ray spinner groups;
  and one fully warned elite arrival with a separate success-only reward.
- Warnings at 20–300 BPM and irregular three-beat bars use actual timestamps,
  span at least one authored bar and one song second, and reject chart gaps
  or terminal windows without a following recovery beat.
- Eight isolated Pulse Grid tiles preserve a central cross, an outer walkway
  and connected corridors wide enough for the full player collision circle.
  Strikes happen once and share the existing shield/damage immunity.
- Ten 180-second songs (30 minutes of simulated music, all six presets) retain
  bounded transient state across more than 1,000 arrivals: at most 100 enemy
  metadata entries, six ranger warnings and one queued grid strike. Song
  boundaries discard warnings and fresh combat has no encounter residue.

## Stronger campaign difficulty — 2026-10-20

The opening wave now reserves two ordinary enemies (four in Swarm Nest), and
the base accrual rate doubles from 0.44 to 0.88 enemies per song second before
arena density modifiers. With `s` completed songs and normalized progress `p`:

- Spawn rate: `0.88 × (1 + 0.35s) × (1 + 1.5p)`.
- Enemy health multiplier: `(1 + 0.35s) × (1 + 0.9p)`.
- Pursuit speed gain: `0.08s + 0.9p`, retaining the 3.6 total speed limit.

Song progress is clamped to the track boundaries. Completed-song scaling no
longer stops at song ten. The five-unit accrual bucket and five/eight-enemy
wave limits previously flattened later-song pressure, particularly at slow
tempos. Accrual and releases now use the existing arena population budget,
including pending arrivals; Swarm Nest reserves two enemy slots per unit.
Full arenas discard released budget, and missing chart intervals still clear
budget and pending arrivals. Safe spawn positions, shooter limits, warning
durations and projectile limits remain enforced.

Five new pacing regressions run actual combat beat commands with activated
waves cleared to measure releases independently of population saturation.
They verify doubled opening pressure, the stronger within-song curve across
all six arenas, rising releases over twenty songs, and comparable releases at
60/120/240 BPM in songs 1, 5 and 10 for ordinary and swarm waves. The first
180-second song releases more than twice the old curve's entire 108.9-enemy
accrual budget. Existing checks also pass for wounded enemy scaling, arrival
activation, population bounds, skipped beats and campaign checkpoint flow.

Validation with Bun 1.4.3: `bun check` passes (414 files), `bun test` passes
(462 tests), and `bun run build` passes with the existing bundle-size warning.
These checks establish the new pacing and bounds; the stronger tuning still
needs a human playthrough to assess feel.

The renderer owns a fixed pool of 80 cosmetic meshes: eight seven-part tile
markers, six three-line marksman lanes and six elite spokes. These have no
physics bodies. Read-only inspection exposes actual visible mesh counts and
poses for browser verification.

## Existing gameplay browser regression

The production build at `output/campaign-regression-dist`, served separately
on port 4187, passed all **13 requested cases**: enemies (1), dash and responsive
HUD (5), upgrades (5), and player ship/comfort settings (2). The normal shared
preview build was not changed.

The first enemy check exposed a stale observation: waiting for both ranger
activation and exactly three surviving spinner bullets could select bullets
from overlapping volleys. The corrected check captures a fresh volley by
projectile ID, asserts its exact 120-degree spacing, and checks spinner rotation
against the actually crossed authored bars. It explicitly verifies that
campaign rules are absent in Quick Play. The other 12 checks passed initially;
the corrected enemy case passed its targeted rerun. No production fix was
needed for this regression.

## Remaining visual and balance checks

The pure simulation demonstrates collection and command bounds, not measured
browser heap, decoded-audio memory or GPU memory. Campaign browser verification
additionally inspected a live Marksman warning with effects Off: its three
warning meshes stayed visible, and pausing retained the exact song time, fixed
geometry and strike deadline. The full campaign browser pass also included
Pulse Grid stages, replay and inter-song cleanup. See
[campaign verification](campaign-verification.md) for the recorded evidence.

Real-playlist balance still needs human playtesting across short/long tracks
and changing tempos. In particular, assess late-run damage upgrades against
elite health, whether marksman lines stay readable during section shockwaves,
and whether Pulse Grid safe corridors remain clear alongside enemy fire.
The warning title and visual charge begin on authored beats; no independent
alarm loop or wall-clock gameplay animation is introduced.
