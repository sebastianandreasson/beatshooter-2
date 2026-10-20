# Beat pulse timing

Implemented 2026-10-20 in Shallot 0.10.0.

## Behavior

- The shared musical envelope attacks on each authored beat, eases out during
  its first 55%, and rests until the next beat. Spectrum accents, laser sweeps,
  aurora/particle travel, wireframes, echoes, floor lighting and bloom use this
  timing. Audio features still govern their strength and shape.
- Stars travel 2.5 units per beat in distinct surges. Section transitions keep
  their integrated hyperspeed boost, adding up to 120 units/second. Calm softens
  the surges and reduces the section boost; existing comfort controls remain.
- Damage text appears at 55% size at impact. On the next actual beat it pops
  to 145% (160% for critical hits), settles to 108% (112% critical), holds its
  position for the first 18% of that beat, then rises. Opacity stays full through
  65% and fades by the following beat. Critical hits retain gold color and larger
  type; the decorative star prefix was removed. Effects Off and reduced motion
  keep full-size, stationary essential feedback.
- Chasers and approaching rangers surge toward the player once per accepted
  beat and stop between strides. Spinners keep their stationary shooter role.
  Knockback remains immediate. Ranger stopping distance and all attack timings
  are unchanged.
- The stride integrates the eased beat curve over the interval between consumed
  audio observations. Extra physics ticks at the same audio position cannot
  replay movement. At ordinary tempos, one stride preserves the previous average
  pursuit distance. Its distance is capped to 0.9 seconds of base speed for slow
  songs. No following timestamp means one bounded stride, not invented repeats.
- Gameplay movement uses raw accepted audio position. Visual calibration and
  effects preferences cannot change enemy movement. Pause, seek and retry retain
  their existing lifecycle. Hidden stage meshes now reset their complete pose so
  seeking also reconstructs invisible pool slots deterministically.

## Verification

- Bun 1.4.3: 354 CPU tests passed, 51,181 assertions across 49 files; `bun check`
  passed (380 files at the final check).
- Production build passed, 470 modules. No dependencies, assets or GPU targets
  were added.
- New tests exercise 20–300 BPM, irregular beat intervals, gaps, duplicate beats,
  overshoot prevention, equivalent stride distance at 30/60/144 Hz and repeated
  physics ticks at a held music position. Existing tests cover ranger stopping,
  knockback, damage readability, pause/seek/retry, section boosts and comfort modes.
- A production Chromium run used normal Practice controls, observed movement
  before aiming, then aimed at enemies. It recorded 702 animation frames.
  Across 36 early-beat movement samples the chaser averaged 5.30 units/second,
  peaking at 7.52. All 34 late-beat rest samples measured exactly zero movement.
- Eight complete damage events were observed growing from 0.55 scale to 1.45,
  or 1.60 for the critical hit. Their first peak frames occurred 0.0068–0.0176
  beats after the accent (within one render frame at 120 BPM).
- All 19 browser scenarios passed across the initial and focused follow-up
  runs: damage, enemy arrivals and attacks, pause/retry, shader fallback,
  section transitions, resizing, calibration and comfort settings.
- The complete 72-second demo finished through normal keyboard/pointer input:
  6,788 points, 65 kills, 25 health. All six sections and five transition waves
  were observed. The earlier 100-ms aiming route without dashes lost at 66s;
  the current playthrough follows targets every 35ms and uses real beat-timed
  Space presses along clear route segments. Gameplay health and clocks remain
  untouched. Arrival screenshots now run outside the time-sensitive pause
  assertion, so image readback cannot accidentally advance past activation.
- The sequential production stress benchmark passed on Apple M1 Max / Chromium
  156.0.8078.4, at 1200×924. Both Off and Standard measured 600 frames at a
  16.666ms mean and 16.670ms P95/P99, with zero failures. The fixture replenishes
  200 enemies and 500 projectiles and emits 16 cosmetic death bursts per beat;
  Standard observed up to 256 shards, eight rings and 100 damage labels. This
  meets the existing 60 FPS criterion on that desktop; vsync-limited intervals
  do not measure GPU headroom.

Ignored artifacts: `output/playwright/beat-pulse-witness.json`,
`output/playwright/beat-pulse-summary.json`, `output/beat-pulse-unit.log`,
`output/beat-pulse-build.log`, `output/beat-pulse-browser.log`,
`output/beat-pulse-followup.log`, `output/playwright/beat-pulse-benchmark.json`
and their browser result folders. Browser checks used the isolated
`output/beat-pulse-dist` build so concurrent agent work did not replace it.
