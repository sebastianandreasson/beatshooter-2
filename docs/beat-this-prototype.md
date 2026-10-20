# Beat This! local-track prototype

Implemented 2026-10-20. Tracks stay on the user's device. This experiment tests
the browser pipeline and exposes its actual detections for listening review.
It does not assume that every model prediction is musically correct.

## Try it

```sh
bun install --frozen-lockfile
bun run setup:audio
bun run dev
```

Open the game, choose **Import local audio**, select a track and click
**Analyze beats**. After analysis, **Detected beats** is selected automatically.
Use **Preview section** to hear the start, middle, end, or full track with the
metronome. Higher clicks mark detected bar starts. Keep the game window focused;
focus loss stops preview playback. **Play this track** uses the same detected
timestamps. **Manual BPM** remains available when a regular hand-set grid is
more useful.

For listening review, record the track, section or timestamp, and whether:

- Clicks align with the musical pulse, or consistently lead/lag it.
- The rhythm unexpectedly switches to half or double speed.
- Higher clicks match bar starts.
- A breakdown or quiet introduction creates missing or extra beats.

Start with **I Can't**, which produced a regular chart, then inspect the three
tracks with warnings. No human listening assessment has been recorded yet.

## Measured results

Production Chromium 156.0.8078.4, Apple M1 Max / Metal 3, macOS arm64,
Bun 1.4.3, WebGPU worker, 1280×900 viewport. Each analysis includes mono
resampling, worker/model initialization and inference; file decoding is outside
the analysis timer. The model is served over localhost. These measurements do
not estimate an internet user's first model download or mobile performance.

| Track | Duration | Beats | Downbeats | Analysis | Timing diagnostics |
| --- | ---: | ---: | ---: | ---: | --- |
| Hyper Spoiler | 4:32 | 533 | 165 | 6.8 s | Irregular spacing, half/double-time changes, short intervals, long gap |
| I Can't | 3:08 | 309 | 78 | 5.6 s | No interval/bar warnings |
| Magna Divide | 4:16 | 452 | 130 | 5.4 s | Irregular spacing, half/double-time changes, short intervals |
| Siriusmo Itchy from Enthusiast | 3:33 | 470 | 136 | 5.6 s | Irregular spacing, half/double-time changes, short intervals |

The original 72-second demo returned all **144 beats and 36 downbeats**,
matching its authored timestamps within the 70 ms comparison window. Median
beat error and 95th-percentile beat error were both 20 ms. This regular synth
fixture verifies timing, but does not establish general music accuracy.

All four private tracks passed full-file inference, metronome preview,
detected-chart gameplay, retry with unchanged chart identity, and clean return
to the menu. Missing-model recovery and cancellation passed. No unexpected
network requests or uncaught page errors were recorded.
The demo also passed start/middle/end/full preview positioning checks.
See the [browser measurement record](beat-this-browser-2026-10-20.json).

The complete game regression passed **74 unit tests / 397 assertions** and
**26 browser tests**, including a full demo playthrough. Type checking,
production build, and desktop/mobile UI inspection passed.

## Original-model parity

The exact browser-preprocessed mono PCM was exported locally and passed to the
official **Beat This 1.1.0 `final0`** implementation, with Torch/Torchaudio 2.6.0,
CPU inference and minimal postprocessing (no DBN). **Every beat and downbeat
timestamp matched exactly on all four tracks.**
The final browser rerun retained those exact matches. See the
[original-model comparison record](beat-this-reference-2026-10-20.json).

This establishes implementation parity: the irregular detections also occur
in the original model. It does not establish accuracy against human annotations.
The test tracks and decoded PCM remain under ignored directories.

## Implementation

- Pinned `@jgorset/beat-this@1.0.0` and ONNX Runtime Web 1.23.2.
- Setup verifies the 83,008,106-byte ONNX model's SHA-256 and prepares the
  matching asyncify runtime. See [asset provenance](../public/models/README.md).
- Arithmetic mean of all audio channels, antialiased resampling to 22,050 Hz,
  dedicated worker, local transfer of analysis PCM.
- Worker termination on cancellation/completion; stale-result rejection through
  decode, analysis, preview and session loading.
- One decoded file retained for analysis, preview, play and retry.
- Exact beat timestamps retained. Pickup bars and changing meter are supported.
  Inferred missing boundaries do not fabricate accented downbeats. When no
  usable bar sequence exists, explicitly labeled groups of four are used.
- Analyzer and chart versions plus file-content SHA-256 separate best-score
  identities for different detected charts.
- Analysis results are session-only. No persistent analysis cache, automatic
  half/double-time correction, or beat editor is implemented in this prototype.

The displayed BPM is a median-interval summary, affected by the model's 20 ms
time grid; it is not used to regenerate the detected timestamps. Warnings
describe timing patterns, not calibrated confidence or proof of an error.

The 256 MiB PCM limit is checked after decoding. It is not a streaming decoder
or a guarantee about browser peak memory during decoding. Model/GPU memory is
additional.

## Reproduce

With a production preview on port 4175 and the four test tracks in the
gitignored `local-audio/` directory:

```sh
bun tests/audio-analysis.ts http://127.0.0.1:4175
```

This writes timing arrays, screenshots and a report under
`output/audio-analysis/`. It also checks the generated demo against its authored
beat timestamps and verifies the preview/play/retry flow through ordinary UI
actions.

Optional original-model comparison, after running the browser experiment and
with a development server on port 4174 (POSIX shell commands):

```sh
bun scripts/export-analysis-pcm.ts
uv venv --python 3.12 output/audio-analysis/reference/.venv
uv pip install --python output/audio-analysis/reference/.venv/bin/python -r scripts/audio-reference-requirements.txt
output/audio-analysis/reference/.venv/bin/python scripts/audio-reference.py
```

The Python environment and checkpoint are optional verification tools, not game
dependencies. The first reference run downloads the original model weights;
audio is not uploaded. The exporter uses the completed browser report to select
files and writes a manifest with file and PCM hashes. Rerun the export after
changing the test tracks or browser report; the comparison requires matching
inputs and verifies the original checkpoint checksum before inference.
