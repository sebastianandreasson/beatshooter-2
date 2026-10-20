# Downbeat dash and bottom beat indicator

Implemented 2026-10-20 on Shallot 0.10.0.

## Behavior

Press **Space** within **100 ms before or after an accented bar start**. Each
downbeat grants one dash. A held key does not auto-trigger, and an off-beat
press is discarded rather than queued. Count-in, pause, menus, loading, track
completion, suspended audio and stale clock observations reject input.

Dash direction uses the held WASD/arrow direction, normalized for diagonals.
Without movement input it uses the pointer aim. It retains wall and enemy
collisions and grants no additional damage immunity.

Timing uses the AudioContext-backed transport position at the key event,
avoiding an extra previous-frame timing penalty. Actual authored/detected
`downbeat` timestamps determine eligibility; inferred unaccented boundaries
do not. No fixed-BPM reconstruction is used for analyzed tracks. Visual timing
calibration remains cosmetic and does not alter dash eligibility.

Duration is one quarter of the local beat, clamped to 80–180 ms. The nominal
maximum target distance is 3.6 world units, approached through fixed-step
physics with a speed cap. Absolute music-time targets prevent repeated fixed
updates or the resume lead-in from adding travel while the song position is
held. Collisions and up to one presentation interval of terminal undershoot
can reduce actual distance; no late movement is added after the envelope ends.
Normal movement resumes without retaining boosted velocity.

The HUD beat panel now sits at the bottom center above the track progress bar.
Regular diamonds are 18 px; the first is 24 px. The first diamond gains an
outline during the dash window, with a **Dash ready** label and Space hint.
It retains actual bar sizes, wraps unusual meters, and adds no independent
animation or large brightness flash. The beat fill follows the existing visual
clock; the readiness outline/label follow actual input eligibility.

## Verification

Using Bun 1.4.3:

```sh
bun check
bun test
bun test ./tests/player.node.ts
bunx playwright test tests/dash.e2e.ts --workers=1
bunx playwright test --workers=1
```

- Type checking: 291 files, no errors.
- Unit suite: 127 tests / 7,636 assertions passed. New coverage includes the
  inclusive timing window, exact variable-tempo accents, pickups/inferred bars,
  no buffered presses, one use per accent, direction/origin ownership,
  calibrated visuals versus raw input time, pause and generation/seek resets.
- Actual Shallot solver: 4 tests / 660 assertions passed. Includes the fastest
  45-unit/s diagonal dash into a corner, planar locks, normal-speed recovery,
  reset cleanup and 270 fixed steps against held musical targets.
- Four focused production browser tests passed: keyboard timing/holding,
  direction, pause/resume/retry and desktop/mobile HUD layout.
- Full production browser regression: **35 tests passed** in 3.7 minutes,
  including the full demo, ten retries, local audio, settings, focus loss,
  shader fallback and reduced-motion checks.
- Production build passed with the existing upstream bundle-size advisory.

The desktop and narrow-screen captures were visually inspected. The panel is
centered, larger, within viewport bounds and separated from the progress bar
and control hints. Captures are local ignored files:

- `output/playwright/dash-hud-1280.png`
- `output/playwright/dash-hud-390.png`

The timing window and movement strength are initial tuning values, ready for
playtesting with the player's intended audio device.
