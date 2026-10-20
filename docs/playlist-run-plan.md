# Multi song runs and music library plan

**Draft for review. No gameplay implementation is included.**

Build a persistent local music library, an ordered playlist builder, and a
ten-song run connected by arena choices. Songs follow the player's playlist;
the branching map decides **how the next song plays**, with three different
arena challenges to choose from. Level, XP and upgrades persist through the
run. Each cleared song restores full health. Death or completing the last song
ends the run; the library and saved playlists remain.

## Recommended player flow

1. **Add music to the library.** Select or drop multiple files, then watch a
   queue import and analyze them. Tracks remain available after reopening the
   game in the same browser.
2. **Build a playlist.** Name it, pick songs from the library, reorder them,
   preview timing and see the total playing time. Default run length is ten
   song slots. Explicit repeats are allowed, so the current four test tracks
   can fill a run; the game never silently adds repeats.
3. **Start a new run.** Copy the playlist into the run, generate its map, and
   choose the existing free starting upgrade once.
4. **Choose the first arena.** Show the first song and three challenge cards.
   Confirming an arena prepares and saves its entry checkpoint before count-in.
5. **Play the complete song.** Keep the current movement, shooting, XP pickups,
   dash and live level-up choices.
6. **Settle the cleared song.** Stop combat and music, collect remaining dropped
   XP, apply completion rewards and resolve pending upgrade choices. Restore
   health to the resulting maximum.
7. **Return to the map.** Show the completed route, current build, next song,
   and three new arena choices. The player controls when the next song starts.
8. **Finish or die.** Show a run summary and retire its active save. Starting
   again creates a fresh character and map.

Keep **Quick Play** and **Practice** available independently. They do not
overwrite the suspended multi-song run. Initially support one resumable run,
with a clear **Continue run** action on the main menu.

Ten full techno tracks can be a long session. Show the sum of their actual
durations before starting and the remaining duration on the map. Play full
songs in this version; automatic cuts, medleys and crossfades are separate work.
Internally support arbitrary playlist lengths so shorter runs can be added
without changing the save format.

## The map and arena choices

Use a ten-step route with the completed path behind the player and three
branches into the next encounter. Branches reconverge after each song, keeping
three choices available at every step. This gives the readable path selection
of a roguelike map without promising a larger graph with inaccessible routes.
Future song titles are visible; the current three challenges receive full
details. On small screens, the route can scroll while the current choices stay
readable.

Each card shows an arena preview, challenge description, threat level and
reward. The next song's name, duration and timing mode sit above the cards.
The choice changes encounter composition, hazard placement and arena accents;
it does not replace or reorder the song.

Generate the map's choices from the run seed and save them. Offer three distinct
presets, avoid repeating the same set on consecutive songs, and include a
lower-pressure option. Early songs introduce mechanics separately. Later songs
use stronger variants; song ten is a finale using familiar rules, rather than
requiring a separate boss system.

### Initial challenge set

| Arena | What changes | Suggested risk and reward |
| --- | --- | --- |
| Mixed Assault | Balanced waves of existing enemies, with alternating approach sectors and clear breathing space. | Lower threat; normal XP. A dependable option for a fragile build. |
| Swarm Nest | Larger groups of weaker chasers arrive in scheduled bursts; fewer ranged enemies. | Medium threat; a modest completion XP bonus. Rewards crowd control. |
| Marksman Outpost | Rangers approach from marked sectors and fire aimed volleys on main beats. Other enemy pressure is reduced. | Medium threat; a modest completion XP bonus. Rewards movement and positioning. |
| Spinner Crossfire | Small, capped groups of spinners create overlapping three-way firing patterns, supported by a few chasers. | Medium threat; a modest completion XP bonus. Rewards prioritizing stationary threats. |
| Elite Hunt | One enhanced existing enemy arrives after a clearly announced musical cue, with a distinct silhouette, health bar and readable attack variation. Ordinary waves are reduced while it is alive. | Higher threat; bonus XP for killing the elite and surviving the song. |
| Pulse Grid | Marked floor tiles or lanes warn, activate on a musical beat, and recover before moving elsewhere. Several safe paths always remain. Enemy density is reduced. | Higher threat; a larger completion XP bonus. Rewards reading the floor and timing movement. |

Marksman warnings lock their aim when the warning begins; they cannot follow
the player until the shot lands. Crossfire groups alternate firing bars rather
than filling the screen at once. Swarm enemies divide the ordinary wave's XP
budget across their larger population, so more bodies do not automatically
make that option the best source of upgrades.

These six presets reuse the three existing enemy types and add two substantial
systems: elite variants and floor hazards. They should be distinct through
gameplay and silhouettes, not just a palette change. Solid cover, moving walls,
escort objectives and bespoke bosses can follow later because they introduce
new collision, navigation or objective rules.

Use XP as the initial reward currency. A starting balance proposal is **10%
extra ordinary earned XP** for medium challenges and **20%** for Pulse Grid,
capped at half the next-level XP requirement captured at song entry. Show the
percentage and cap on the card; exclude other bonuses from that calculation.
Mixed Assault has no bonus. Elite Hunt instead offers a fixed bonus of half
that entry requirement for killing its elite and clearing the song. Elite
bonus eligibility is recorded during the song but paid only on success.
Surviving to the audio's end always clears the encounter; an undefeated elite
forfeits its bonus, rather than extending combat into silence.

No healing or rest nodes are needed while every cleared song restores health.
No shop, currency or permanent progression system is required for this version.

## Progression and timing rules

| Carries through the run | Starts fresh for each song |
| --- | --- |
| Level, XP toward the next level, total earned XP | Song time, beat/bar cursors and section index |
| Upgrade ranks and permanent stat modifiers | Enemies, arrivals, projectiles, traps and dropped gems |
| Maximum health and regeneration upgrade strength | Current health, restored to effective maximum |
| Run score, kills and damage totals | Player position, velocity, dash use and invulnerability |
| Upgrade offer random state and any pending choices | Regeneration deadline, starting five song seconds later |
| Completed route and earned rewards | Effects, audio nodes and song-only challenge modifiers |

The free starting upgrade occurs **once per run**, including after reopening.
Choose all pending upgrades before entering the next song, then calculate full
health using the updated maximum.

At successful song completion, bank XP from gems already dropped, including
gems still travelling toward the ship. Surviving enemies and unfinished spawn
animations award nothing. Preserve already offered upgrade cards and queue any
new levels behind them. For the final song, record the final XP and level but
do not require choices that would have no further gameplay.

If lethal damage and completion occur in the same accepted final combat step,
**death takes precedence**. Once settlement begins, no further enemy attack or
hazard damage can occur.

All new attacks, spawns, trap phases and combat effects use the existing music
clock. Telegraph dangerous hazards for at least one authored bar and at least
one song second, then activate on an eligible main beat. Choose a later beat
when necessary; never shorten a warning just because BPM is high. Use the same
chart bar semantics as current combat. Unsupported gaps suppress an event
rather than releasing a backlog when timing returns. Do not schedule a hazard
or elite arrival that cannot finish its warning before the track ends.

Hazards must preserve a reachable safe region and respect the existing shared
damage immunity window. A warned region stays fixed, and a trap damages once
on its strike beat rather than every rendered frame. Reduced effects may remove
glow, beams and motion, but must retain unmistakable warning shapes and active
danger boundaries.
Pause freezes the music and hazards together. The inter-song map is stationary;
card selection can respond immediately to the player without inventing an
independent gameplay beat.

### Difficulty across different songs

Introduce one campaign difficulty profile combining encounter number, chosen
challenge and progress through the current song. Keep it independent of the
player's actual build so upgrades still make the player stronger.

The current game grows waves by bar count and enemy health by detected section
count. Simply adding a run multiplier would punish long, fast or heavily
segmented tracks disproportionately. Campaign mode should bound those existing
ramps and schedule its pressure targets across normalized song progress, with
actual wave releases still landing on beats. Quick Play can retain its current
rules. Tune the exact limits with real playlists before considering balance
finished.

Maintain hard enemy, projectile and hazard budgets. Give slow songs minimum
wave spacing and fast songs maximum spawn rates. Longer songs still offer more
time to earn XP and take damage; they are not represented as equivalent to
short songs. Do not add cross-playlist competitive leaderboards in this scope.

## Library and playlist scaffolding

Library entries contain the original compressed audio, content hash, display
metadata, duration, timing configuration, validated beat/downbeat data, section
data and cached visual features. Separate analysis revisions from the original
audio. Renaming a track does not duplicate its audio.

Importing the same file again recognizes its SHA-256 content hash even if its
filename changes. A different recording with the same title remains a
different track. Allow optional title/artist edits and the existing manual BPM
and offset controls.

Show explicit states: importing, queued, analyzing, ready, needs timing,
interrupted and failed. One bad file must not discard the rest of a batch.
Keep successfully stored originals when analysis fails, offering retry or
manual timing. If section detection fails but beat timing succeeds, the track
remains playable. Interrupted analysis restarts that job after reopening; it
does not attempt to serialize a running model.

Only tracks with valid audio and a usable chart can enter a new run. Permit
building a playlist while analysis continues, but disable starting until all
its entries are ready. Explain any blocked entries individually.

Save named playlists as ordered references, with a distinct identity for each
slot so repeated songs work correctly. At run creation, freeze the ordered
audio hashes, chart revisions, durations and map choices. Editing the library
or playlist later affects future runs. Reanalysis never silently changes the
timing or section difficulty of a suspended run.

Protect audio and chart revisions referenced by the active run from deletion.
For other deletions, show affected playlists and require explicit removal of
their entries. Deleting a saved playlist does not remove its active run's
frozen copy. Missing audio after storage loss can be relinked by importing the
same content hash; never silently substitute another recording.

## Save and resume contract

Save **the character at song entry**, not a partially played arena. For example,
if song four starts at level eight and the player exits at level ten, Continue
restarts song four at level eight, with the same arena, full entry health and
saved upgrade ranks. Progress from the first three songs remains safe.

This rollback must be explained beside **Save and exit**:
“This song will restart. Progress earned during this song will be replayed.”
An ordinary pause keeps the exact current state in memory; reopening or leaving
the run uses the entry checkpoint.

| Event | Durable result and next Continue behavior |
| --- | --- |
| Creating a run or choosing its starting upgrade | Preserve the run, initial offers and selected upgrade. No reroll or second free choice on reload. |
| Confirming an arena | Commit its entry build, song/chart identity, challenge, combat seed and upgrade RNG state before count-in starts. |
| Exiting or reloading during count-in, play or pause | Replay that same song from the beginning with its entry checkpoint. Mid-song XP, picks, score and damage do not accumulate across attempts. |
| Successfully clearing a song | Atomically commit earned progression, one-time rewards, completed route and the next intermission. Reload goes to intermission, not back into the cleared song. |
| Choosing an intermission upgrade | Commit the choice and remaining queue before exposing the next choice. Reload preserves the same unresolved offer. |
| Exiting on the map | Return to the same next song and three saved arena choices. |
| Death, victory or confirmed abandonment | Record a terminal result and remove Continue for that run. Library and playlists survive. |
| Failure before a transition commits | Keep the last valid checkpoint. Do not show “Saved” or begin the next song. |

Save each transition when it happens; do not depend on a tab-close handler.
If the browser closes before song-clear settlement commits, the last durable
entry checkpoint is replayed. If it closes after commit, the intermission is
restored. Completion and reward writes must be idempotent: repeating an event
cannot award XP or advance the playlist twice.

Terminal state is permanent: delayed checkpoint writes cannot resurrect a
defeated, completed or abandoned run. Persist that state before showing its
saved result. If the browser is killed before a terminal write commits, only
the earlier entry checkpoint is recoverable; a local save cannot guarantee
recording an event it never finished writing.

Provide separate **Save and exit** and **Abandon run** actions. Starting another
run requires confirming replacement of an existing suspended run. Return from
the app through a Continue summary showing song number, song title, arena and
the restart behavior; require a click before audio resumes.

## Storage and recovery

Use one IndexedDB database for original audio Blobs, track records, analysis
revisions, playlists, run state and compact completed-run summaries. IndexedDB
supports these data types and atomic updates spanning multiple stores, which
lets a transition update progression and checkpoint together.
[IndexedDB specification](https://www.w3.org/TR/IndexedDB/#transaction-lifecycle).

Hashing, audio decoding and inference finish outside a write transaction.
Only report success after the transaction completes. Keep existing preferences
in localStorage and model weights in the current versioned Cache Storage.
OPFS adds no necessary capability for this first immutable-audio workflow.

Run one decode/analysis job at a time and suspend queued GPU analysis during
gameplay. Decode only the current song initially; transition screens provide
time to load the next one. Keep the current 100 MiB original-file and 256 MiB
decoded-audio limits, while recognizing that the decoded limit is currently
checked after allocation. Test real peak memory, release old audio/model work
and revoke object URLs. Never keep all ten decoded songs in memory.

Show storage usage and request persistent storage when the library is first
used. Persistence may be denied, quotas vary, and clearing browser site data
removes the library and saves. Files remain local to this browser/device and
site origin; switching between development ports also changes storage.
[Browser storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

If storage is unavailable, keep Quick Play usable but do not promise a resumable
campaign. On a failed checkpoint write, remain safely paused with Retry and
recovery options. Never silently evict user music to make room for model caches.

Include an export/import recovery file containing playlists, charts and run
state, clearly labelled **audio not included**. Restoring it requires relinking
the original music files by hash. A full archive containing audio and cloud
sync are later features. Version and validate imported records, reject invalid
ranks/indices/references, and migrate compatible saves explicitly. Check rules
compatibility before reconstructing stats or offers, including upgrade caps,
encounter difficulty and reward definitions. Unsupported run rules must produce
a recoverable message rather than resetting progress.

Only one tab may own an active run. Use an exclusive Web Lock where supported,
plus transactional run revisions to reject stale writes. A second tab may
browse the library but must not start a conflicting run; implement a database
lease fallback if the lock API is unavailable. Give the analysis queue its own
exclusive owner so multiple tabs do not start competing GPU jobs.
[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).

## Code structure

The existing `src/session/index.ts` owns both a song and the entire character.
`clearSession()` calls `createCombat()`, and `startSession()` always grants a
new starting upgrade. Both need to be split before multi-song progression is
safe. The existing content hashing and chart validators in `src/tracks/` and
`src/analysis/` can be reused.

| Area | Responsibility |
| --- | --- |
| `src/library/` | Database schema, original audio, metadata, chart revisions, analysis queue, storage/recovery UI data. |
| `src/playlists/` | Named ordered playlists, repeated slots, readiness validation and immutable run snapshots. |
| `src/run/` | Overall run state machine, checkpoints, saved route, progression settlement, terminal results and resume. |
| `src/encounters/` | Seeded arena offers, challenge definitions, campaign difficulty and reward rules. |
| `src/hazards/` | Beat-scheduled telegraphs, activation, collision/damage, comfort presentation and cleanup. |
| Existing session/combat/stats/UI | Run one song, reconstruct the character, apply elite variants, display library/map/intermission and preserve Quick Play. |

Store canonical progression: base stats/rules version, upgrade ranks, scoped
permanent modifiers, XP and metrics. Persist upgrade `pending`, `earnedThrough`,
`offeredLevel`, offer IDs, RNG state and an explicit starting-choice-completed
flag; XP level alone cannot reconstruct the queue. Recompute effective stats
on restore. Do not restore by calling the normal “choose upgrade” action, which
also heals and changes queues.

Use a fixed handoff order: remove old song modifiers; settle permanent
progression and pending choices; apply the next challenge's modifiers; heal to
the final effective maximum; capture its entry checkpoint. Before count-in,
reset song clocks/cursors, regeneration deadline, dash state and section index.
Persist challenge definitions separately from permanent modifiers so restoring
an entry cannot apply the same modifier twice.

Keep map generation, upgrade offers and combat randomness independent.
Replaying restores the same initial seeds and offers; player actions may still
lead to different combat outcomes. Do not serialize ECS entities, audio
contexts, object URLs, render resources or absolute song deadlines.

Use explicit run states such as `starting`, `choosing-arena`, `song-active`,
`intermission`, `completed`, `defeated` and `abandoned`, separate from the
existing song playback phases. “Loading” and a failed audio start do not consume
an encounter. Retain cancellation tokens and add run-revision checks so a late
load or analysis result cannot mutate a replaced run.

## Implementation sequence and acceptance

1. **Persistent library.** Multiple imports, durable original files, analysis
   cache, manual timing, deduplication and per-file recovery. Prove reload can
   play a stored song without reselecting its file or rerunning valid analysis.
2. **Playlist and progression separation.** Build/reorder/save playlists; add a
   plain two-song run first. Prove XP and ranks carry, health refills, transient
   entities clear and the free upgrade happens only once. Keep this internal
   slice simple before adding the map.
3. **Durable run checkpoints.** Add Continue, intermission saves, Save and exit,
   abandonment, versioning, tab ownership and recovery export/import. Fault-test
   every transition before building additional challenge content.
4. **Route map and existing-enemy presets.** Add the ten-step route, stable
   three-card offers, threat/reward previews, Mixed Assault, Swarm Nest,
   Marksman Outpost and Spinner Crossfire.
5. **Elite and Pulse Grid encounters.** Add distinct elite attacks and the
   reusable hazard scheduler, telegraphs, safe-space rules and XP bonuses.
6. **Full-run balance and verification.** Play ten-song sequences across short,
   long, fast, slow and irregular charts; check progression pacing, late-run
   enemy pressure, memory, comfort modes and end-to-end recovery.

Release acceptance must cover:

- All ten songs complete with one persistent build, with a fresh run after
  victory/death and no loss of library data.
- Reload at entry, mid-song, during a pending upgrade, during settlement and
  on the map; no duplicate rewards, rerolled choices or extra starting upgrade.
- Final-beat XP and simultaneous death/completion; no danger after settlement.
- Duplicate clicks, stale async results, write failures, quota exhaustion,
  corrupt/older saves and two-tab conflicts preserve the last valid state.
- Repeated playlist songs use independent encounter identities; playlist edits
  and reanalysis cannot alter an active run; missing files can be relinked.
- Hazards follow authored variable-tempo beats, pause correctly, retain readable
  warnings with effects Off and never close every safe path.
- Entity counts and decoded-audio memory remain bounded across all ten songs
  and repeated resume attempts. Quick Play, Practice, dash, ship effects and
  current upgrade behavior retain regression coverage.

## Decisions for review

The proposed defaults are **ten full songs with explicit repeats allowed**,
**fixed song order with three arena choices**, **full healing after every
clear**, and **all mid-song gains rolled back when that song is replayed**.
The map reconverges between songs, offers XP-based risk rewards, and keeps one
active local save.

The largest design choices to change before building would be a true branching
graph that restricts later routes, letting arena choices also choose different
songs, retaining mid-song upgrades despite restarting the song, or requiring a
boss kill for the finale. Each changes the save or pacing model; none is assumed
in this draft.
