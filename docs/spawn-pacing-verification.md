# Enemy arrivals and level-up pacing

Implemented against Shallot 0.10.0 with Bun 1.4.3.

## Enemy arrival

Each wave begins on its authored downbeat. Enemies descend through a faint,
kind-colored beam while spinning and growing from zero scale over the interval
to the next authored beat. A floor outline marks the arrival position. The
preview retains each archetype's silhouette, including shooter accents, and
meets the active enemy's final pose.

`src/combat/index.ts` keeps these arrivals in `pendingSpawns`, separate from
active enemies. They cannot move, attack, take damage, cause contact damage,
receive ricochets, or drop XP. Their presentation entities have no physics
`Body` or `Shape`, and no health bars. The next actual beat activates the enemy
and gives it normal combat ownership. Live enemies and reservations share the
existing population cap; shooter spawn grace remains intact.

`src/enemy-spawn/index.ts` owns the cosmetic entities, and `pose.ts` derives their
pose directly from the music playhead. Pausing freezes the exact pose, slowdown
slows the arrival with the music, and visual calibration cannot change combat
activation. Activation, restart, menu, and results remove the preview entities.
Pausing also settles beat commands already accepted by the music clock, even
when no fixed physics step has run yet, so an activation beat cannot be lost.
Calm lowers motion; Off and reduced motion retain growth and the floor marker
without beams, spinning, or vertical travel. No additional full-screen flashes
or postprocessing are used.

The session supplies the actual next beat time, including tempo changes. A
final beat without a following beat, or a detection gap longer than 3.05 seconds,
does not create an arrival with a made-up activation time. Valid 20 BPM intervals
remain supported.

## Faster choices and slower leveling

`src/session/upgrade-timing.ts` chooses a power-of-two subdivision of the
authored beat 100–140 ms ahead in song time. The existing 1× to 0.12× audio ramp
therefore takes approximately **180–250 ms in real time**, including at slow
tempos. Missing detections and track tails retain a short bounded transition.
The music and simulation then freeze for the three-card choice; card selection
resumes normal playback from the retained position.

`src/experience/state.ts` raises the initial requirement from 30 to **36 XP**
and subsequent increases from 15 to **18 XP**, a 20% increase. Requirements are
36, 54, 72, 90, and so on. Gems remain worth 10 XP. Four pickups earn the first
level and carry 4 XP toward the next.

## Verification

- `bun test`: 242 tests passed, 12,739 assertions across 30 files.
- `bun test ./tests/player.node.ts`: 4 real-physics tests passed, 660 assertions.
- `bun check`: no type errors in 324 files.
- Production build: passed, with the existing engine bundle-size advisory.
- Full production browser suite: all 46 checks passed in 5.5 minutes, including
  a completed 72-second demo (6,788 points, 65 eliminations, 25 health).
- After the pause-edge correction, all seven affected browser checks also
  passed on the final build. The upgrade observer was corrected to allow a
  missing final-ramp render frame and rerun separately; it still validates
  the sampled playback curve, exact stop position, frozen combat, and resume.

New combat tests cover intangible arrivals, activation at irregular beat times,
duplicate commands, shooter grace, ricochet exclusion, population limits, and
missing following beats. Presentation tests cover all three enemy kinds, lack
of physics components, frozen poses, calibration independence, comfort settings,
and entity cleanup.
Session regressions verify manual pause and focus loss, including during
slowdown, activate an already-arrived enemy exactly once without advancing
simulation time or replaying its beat on resume.

The production browser checks use normal controls and a read-only inspector.
They compare early and middle arrival poses, confirm no active enemy or physics
body exists during arrival, pause and resume across activation, and exercise
restart/menu cleanup. Separate cases cover Effects Off and OS reduced motion.
The level-up browser check records rendered frames in-page so the shorter
transition is measured without automation round-trip delays.

Reviewed production screenshots:
`output/playwright/enemy-arrival.png`,
`output/playwright/enemy-arrival-off.png`, and
`output/playwright/enemy-arrival-reduced.png`.
