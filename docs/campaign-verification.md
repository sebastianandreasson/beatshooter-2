# Campaign implementation and verification

Implemented on 2026-10-20 from [the approved plan](playlist-run-plan.md).

## Delivered behavior

- Local multi-file library with SHA-256 deduplication, persistent original audio,
  immutable timing revisions, local analysis, manual timing, saved-song preview,
  metadata editing, deletion protection and exact-file relinking.
- Named ordered playlists with explicit repeats, total duration and readiness
  checks. Ten stages are suggested; shorter playlists are supported.
- A deterministic three-choice arena route per song, all six encounter presets,
  stage-based difficulty, full health between songs and permanent build/XP carry.
- One initial upgrade per campaign. End-of-song settlement banks only existing
  XP drops, grants a capped challenge reward once and preserves pending offers.
  Final victory does not force unused upgrade selections.
- Durable song-entry replay, individually committed intermission choices,
  atomic stage settlement and permanent terminal outcomes. Failed saves freeze
  progression with Retry, recovery export and reload-checkpoint actions.
- One campaign owner across tabs, native Web Locks with an IndexedDB lease
  fallback, immediate native-lock recovery after reload, and post-await audio
  ownership checks. Analysis suspends before gameplay across tabs as well.
- Independent Quick Play and Practice. Neither replaces or advances an active
  campaign. Recovery JSON explicitly excludes original audio.

## Automated evidence

Using Bun 1.4.3 and pinned Shallot 0.10.1-next.2:

- `bun test`: 454 passing tests across 62 files, 106,689 assertions.
- `bun test ./tests/player.node.ts`: 5 passing real-physics tests, 746 assertions.
- `bun check`: no errors across 413 files.
- Production builds pass; the existing large-bundle warning remains.
- 13 selected browser regressions pass: enemies, dash/responsive HUD, upgrades,
  ship and visual comfort. The enemy test now compares a single projectile
  volley and the actual number of authored bars crossed.

The run and session tests include ten-song progression, replay rollback,
intermission offer preservation, free-choice uniqueness, atomic failure/retry,
terminal monotonicity, duplicate commands, frozen chart/order identity, and
ownership lost during each asynchronous audio-start/resume boundary. Additional
regressions cover a cancelled Quick Play start overtaken by Continue, disposal
during a save, and retrying an already committed transition after another tab
has advanced or terminated the run.

The library tests use real IndexedDB transaction behavior through
`fake-indexeddb`, including quota rejection, rollback, two-instance ownership,
serialized decoding, recovery validation and original-file relinking.
See [library checks](library-verification.md) and
[encounter timing/cap checks](encounter-verification.md) for details.

## Browser campaign witness

A real Chromium/WebGPU session used an isolated production preview on port 4186.
Two generated audio recordings (8 seconds at 120 BPM and 10 seconds at 150 BPM)
were imported together. Model fetches were deliberately blocked for this case,
proving that originals survive analysis failure and can become playable through
manual timing. Renaming, saving a playlist and ten explicit alternating slots
were exercised through the UI.

The initial Vitality choice was retained. After starting stage one, Save & exit
returned to the menu. A separate saved-song Quick Play completed and left the
campaign at the same entry revision. Reload/Continue restored the same arena,
combat seed and rank, with no second free upgrade. A second reload directly from
a paused campaign also resumed from the entry.

The complete ten-stage route then ran through Mixed Assault, Spinner Crossfire,
Pulse Grid, Swarm Nest and Marksman Outpost. It finished with status `completed`,
song index 10, ten recorded route entries and 11 carried XP (10 ordinary plus
one clear bonus). Every intermission had zero song entities and the baseline
five physics bodies. No completed campaign remained eligible for Continue.

Screenshots are kept in the ignored `output/playwright/` directory:
`campaign-library-empty.png`, `campaign-playlist.png`, `campaign-map.png`, and
`campaign-completed.png`.

## Library, recovery and visual checks

A separate fresh browser session imported the bundled 72-second recording into
the library and successfully ran both local analysis models. Title, artist and
a manual first-beat offset of 0.25 seconds were saved. The playlist builder was
checked with rapid typing/selection as well as normal use; selection and edits
now survive asynchronous UI refreshes.

Recovery JSON was downloaded and imported at a separate, empty browser origin.
The saved map, Vitality rank, playlist, metadata and both chart revisions
survived. The export explicitly reports `audioIncluded: false`. Missing audio
disabled playback; relinking a different recording was rejected, while the
exact original restored it. Preview started and stopped audio without changing
the campaign revision. Continue restored the same map and starting upgrade.

The map was inspected at 1440×1000 and 800×720, with no page-level horizontal
overflow. It shows remaining run time and the next song's duration/timing mode.
The HUD stage label was moved into the vitals flow to prevent overlap with the
song title and shield status.

In a restored Marksman Outpost campaign with effects Off, the actual warning
meshes remained visible. A warning began at 6.25 seconds and was scheduled to
strike at 8.25 seconds, exactly four authored beats later. Pausing at
6.293333 seconds preserved the song time, locked warning geometry and strike
deadline; resuming displayed the same clear three-line warning.

Additional screenshots: `campaign-playlist-final.png`, `campaign-map-final.png`,
`campaign-map-small.png`, `campaign-warning-off-playing.png`, and
`campaign-hud-final.png`.

## Practical limits

Browser storage is local to its origin and may be denied, cleared or evicted.
A recovery JSON is not an audio backup. Uncommitted transitions cannot survive
an abrupt process/browser termination; the last successful checkpoint is the
recovery boundary. Native audio decode cannot be cancelled mid-allocation, so
its result is awaited/discarded and the existing decoded-size limit still runs
after allocation.

The full browser run uses short deterministic recordings for lifecycle coverage.
Thirty minutes of simulated encounter timing additionally verifies entity and
projectile budgets. Real ten-song techno playlists remain the right basis for
human difficulty and visual-comfort tuning; these checks do not claim a measured
upper bound for native browser/GPU memory or final musical balance.
