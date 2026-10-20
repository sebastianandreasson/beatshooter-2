# Song pickup verification

Implemented 2026-10-20 for campaign and Quick Play songs. Four pickups use
separate randomized windows at 12–22%, 32–42%, 52–62% and 72–82% of the song.
Each schedule contains health, magnet and bomb plus one random extra, shuffled
and placed within the central 75% of the walkable arena. Pickups remain on the
floor until physical collection or song teardown. Dojo has no finite-song
pickup schedule.

- Health restores 50, capped at upgraded maximum health.
- Magnet latches attraction for every existing XP gem, with normal physical
  travel, XP awards and upgrade queues. Future drops use ordinary attraction.
- Bomb deals 100 damage once per live enemy as a ring expands over 0.75 song
  seconds to a radius of 25% of arena width (nine arena units by default).
  Pending enemy arrivals remain intangible. Damage feedback, knockback,
  actual-damage metrics, kills, score, XP and elite rewards use the normal path.

Schedules use an independent seeded random stream. Campaign song-entry replay
recreates the same schedule; new Quick Play runs receive fresh randomness.
Spawning and bomb travel use raw song position, independently of beat detection
and visual calibration. Pause holds them, and terminal/settling combat cannot
collect pickups. Presentation uses session-owned meshes with distinct symbols
and colors; essential pickup markers and damage rings remain visible with
effects Off.

## Automated checks

With Bun 1.4.3:

- `bun check`: no type errors in 419 files.
- `bun test`: 470 passing tests, including eight new pickup checks.
- `bun run build`: passes, with the existing bundle-size warning.

Checks cover randomized timing/types/positions, deterministic replay, held and
backward clocks, swept dash collection, upgraded health limits, arena-wide XP
attraction and normal upgrade awards, bomb range and single-hit behavior,
late observations, pending enemy immunity, kill/elite bookkeeping, defeat and
settlement, effects Off, pause and presentation teardown. The campaign session
test also verifies restoring the complete original pickup state on Continue.

## Browser witness

Played the production build through the normal Neon Circuit controls in
Chromium at 1280×800, aiming and moving with pointer/keyboard input. All four
scheduled pickups appeared and were collected: two health, one magnet and one
bomb. The magnet visibly drew floor XP toward the ship; the player reached
level four. Captured the bomb damage ring and its collection notice. Pausing
at song time 54.345 seconds held both the song position and the entire pickup
inspection state, including the ring's 3.762-unit radius. Browser console:
zero errors and zero warnings.

Screenshots in `output/playwright/`: `pickup-health-visible.png`,
`pickup-magnet-live.png`, `pickup-bomb-live.png`, and `pickup-bomb-wave.png`.
