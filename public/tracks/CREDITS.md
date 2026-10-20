# Demo audio and artwork

**Neon Circuit** — an original 72-second, 120 BPM instrumental composed and
synthesized for Beatshooter 2 on 2026-10-20. Its synthesizer, deterministic noise,
melody, harmony, percussion, cover artwork, and beat manifest were created for
this project. No external samples, music recordings, or original Beatshooter
assets were used.

The mint ship icon in `public/icon.svg`, procedural arena/ship geometry, UI
schematic artwork, and short synthesized shot/impact sounds in
`src/session/index.ts` were also created for this project and carry the same
CC0 dedication. Interface type uses installed system fonts; no third-party
font or texture files are distributed.

The track, cover, generator, and manifest are dedicated to the public domain
under **CC0 1.0 Universal**:
https://creativecommons.org/publicdomain/zero/1.0/

The complete deterministic source is `src/tracks/generate-demo.py`. Regenerate
the WAV and manifest from the repository root:

```sh
python3 src/tracks/generate-demo.py
```

Audio: mono 22,050 Hz, 16-bit PCM WAV. The first beat is at 0 seconds; each
subsequent beat is 0.5 seconds later. Every fourth beat begins a bar.

The practice/calibration metronome uses original Web Audio sine waves and
requires no audio asset. User-imported music stays on the user's device and is
neither uploaded nor included in this distribution.
