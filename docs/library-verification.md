# Library persistence verification

The library stores original compressed audio, immutable chart revisions and
metadata in IndexedDB. Playlists store ordered, individually identified slots;
repeated tracks retain separate slot identities. Run checkpoints share the
database so active-run pins and run transitions can commit atomically.

Run the focused storage checks with:

```sh
bun test ./src/library ./src/playlists
bun check
```

The tests use `fake-indexeddb` to exercise actual request and transaction
lifecycles, rather than replacing saves with an in-memory map. Coverage includes:

- SHA-256 deduplication across renamed files, same-name different recordings,
  independent failures in a batch and originals retained after analysis failure.
- Reloading a manually timed song without repeating analysis, preserved older
  chart revisions after reanalysis, repeated playlist slots and exact chart
  loading for a pinned song.
- One analysis job across two service instances; cancellation before gameplay
  starts, waiting for unabortable decode, and resumed interrupted jobs.
- Cross-tab playback suspension using native shared/exclusive Web Locks and a
  renewed IndexedDB lease fallback. Independent Quick Play tabs may coexist;
  analysis waits until all gameplay owners release.
- Atomic rollback across stores, quota rejection without advertising an unsaved
  import, explicit playlist-removal confirmation and active-run deletion protection.
- Recovery without audio, typed visual-feature round trips, exact-hash
  relinking, rejected invalid references and unsupported run rules, immutable
  chart conflicts and permanent terminal run records.
- Storage unavailability remains explicit without making the library a
  prerequisite for Quick Play.

The session must await `library.setGameplayActive(true)` before loading or
starting audio work. `setGameplayActive(false)` releases that suspension.
`persistOriginal(file)` retains a legacy import without starting a competing
analysis job; `persistAnalyzed` accepts an existing analysis or known manual
duration so it does not allocate another decoded buffer.

Only the current playable song is decoded by the library loader. Queue caches
are released after each job and loaded-track disposal revokes its object URL.
Playlist pinning reads chart identities and timing without retaining every
song's visual-feature arrays. Originals retain the existing 100 MiB limit and
decoded audio retains the existing 256 MiB limit; the decoded limit is checked
after decoding, so it is not a guarantee about browser peak allocation.

Browser acceptance still needs actual audio decoding, inference, reload,
quota/permission behavior and UI review. Storage estimates are approximate;
persistent storage may be denied. Recovery files deliberately exclude audio
and are not a full music backup. Clearing site data or changing site origin
does not preserve a local library.
