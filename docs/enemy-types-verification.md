# Enemy archetypes verification

Implemented against Shallot 0.10.0 with Bun 1.4.3 on 2026-10-20.

## Gameplay contract

- Existing coral chasers retain pursuit and contact damage.
- Violet spinners spawn at seeded random interior positions at least seven units
  from the player. They stay in place except for knockback/physical contact.
  On each accented bar start after their spawn bar, their heading turns 30° and
  three shots leave at 120° intervals. Visible barrels match those directions.
- Amber rangers spawn at the perimeter, approach the player, and ease to a stop
  six units away. Within seven units they fire one aimed shot on an accented
  bar start after their spawn bar. Shots retain their original direction.
- Bars cycle chaser → spinner → ranger, starting with one enemy per bar.
  Existing wave growth and the 100-enemy cap remain in force.
- The same authored downbeat commands used by the dash drive attacks. No
  frame timer, visual offset, fixed four-beat assumption or ordinary beat
  grants enemy fire. A repeated command cannot rotate or attack twice.
- Hostile coral diamonds travel at nine units/second, deal ten damage, and
  expire after five seconds or leaving the arena. They hit only the player;
  mint player shots continue to hit only enemies.
- Sweeps account for projectile thickness, lifetime and player motion during
  a dash. Absorbed shots are consumed during the shared 0.9-second damage
  immunity. Immunity is tested at the swept impact time.
- Hostile bullets cap at 120 within the existing 500-projectile total, leaving
  a slot for player fire. A spinner suppresses its entire volley if fewer than
  three slots remain. Rotation still occurs on that bar.
- Pause holds all state. Retry/menu clears bullets, bodies and the three
  presentation-only accent meshes for each ranged enemy. Their transforms
  never write the physics body pose.

## Automated checks

- `bun test`: **143 passed / 8,950 assertions**, including deterministic interior spawn safety,
  movement/stop/resume/knockback, exact authored beat attacks, three-way spacing,
  aim locking, spawn grace, caps, friendly-fire filtering, swept dash collision,
  lifetime, immunity boundary and defeat.
- `bun test ./tests/player.node.ts`: **4 passed**, exercising real Shallot
  physics movement, walls, dash stopping and pause/resume target holding.
- `bun check`: passed across **293 files**.
- `bun run build`: passed; existing bundle-size advisory remains.
- Focused production Chromium check: passed. It observes both enemy silhouettes,
  the spinner's exact turn/three-way volley, the ranger approaching and firing
  one aimed shot, paused poses and retry ownership cleanup.
- The full 72-second demo completed through ordinary keyboard/pointer controls:
  **6,088 score / 58 kills / 15 health**. This playthrough did not use the dash.
- Playing screenshots inspected at
  `output/playwright/enemy-types-playing.png` and
  `output/playwright/enemy-ranger-aimed-shot.png`. Violet three-spoke spinners,
  amber rangers and coral diamonds remain distinguishable against the music floor.
- Initial full browser regression: **35 of 36 passed**. The remaining check
  exposed a one-frame stale dash-use count after retry. Session cleanup now
  resets dash state synchronously; a focused unit regression passes.
  All **12 affected dash, gameplay and enemy browser checks passed** after
  rebuilding, including the original failing case and ten live retries.
  No browser regression remains unresolved.

The four private local audio files were not uploaded or reanalyzed for this
change. Attacks consume the existing validated timelines.
