# LinkSeg section-analysis experiment

Implemented and evaluated 2026-10-20. Local audio stays on the device.
Section predictions are display metadata only. Beat detection, chart identity,
combat and playback timing are unchanged.

## Try it

Run `bun run setup:audio` after installing dependencies, then start the game.
Import a local track to automatically detect beats and song sections. Detected
timing is selected by default; **Analyze again** reruns the analysis. The import
preview shows a colored overview. Start/middle/end/full metronome previews
show the current predicted section; choose **Play this track** to see the
full-width player at the bottom of the arena.

Colors consistently identify intro, verse, chorus, bridge, instrumental, outro
and silence. Text, a legend and the current/next labels supplement color. A
white playhead marks the audio position; future sections are dimmed. Hover a
span for its predicted name and time range. The bar is a read-only timeline,
not a seek control. Pause, slowdown and count-in use the existing song clock.
Manual-BPM tracks, the bundled demo and dojo retain an unsegmented bar. The demo
can be analyzed by importing its WAV. Changing files clears old predictions.

## Implementation and provenance

- Pinned LinkSeg 7-class ONNX model: 1,574,039 bytes, prepared and SHA-256-verified
  by `setup:audio`. The existing ONNX Runtime Web 1.23.2 is shared.
- Selected MIT-licensed numerical frontend/decoder files from LinkSeg-web commit
  `694d27356082712dc82a3e06dbf9c7d543c9e399` are vendored because the advertised
  npm package returned 404 during integration. The loader/cache/demo were not
  imported. See [model provenance](../public/models/README.md).
- The same worker reuses 22,050 Hz mono PCM and detected beats. It releases Beat
  This before loading LinkSeg; tensors and the section session are released.
  Completion/cancellation terminates the worker. Model/runtime requests remain
  same-origin. This integration uses WebGPU, matching the existing analyzer.
- Original 8-second peak-picking half-window and threshold 0 are retained.
  Adjacent equal-label spans remain separate, preserving raw candidate changes.
  Upstream beat-frame quantization/downsampling is internal to LinkSeg and never
  rewrites the gameplay chart. Boundaries are not snapped to downbeats.
- Validated section metadata is copied into each loaded track. Missing, invalid
  or failed section results preserve the beat chart and keep playback available.
  The import dialog omits warning text. Manual timing is under **Timing**; displayed
  BPM is rounded without changing the detected beat timestamps.
- Metadata is session-only. No gameplay changes, persistent cache,
  section correction UI or calibrated confidence score were added.

## Measured results

Production Chromium on Apple M1 Max, macOS, Bun 1.4.3, WebGPU; models served
from localhost. Timings include frontend work, model initialization and section
inference. They do not predict internet download time or mobile performance.
The isolated verification preview used port 4187 and its own build directory.

| Track | Duration | Raw spans | Section analysis | Entire analysis |
| --- | ---: | ---: | ---: | ---: |
| Neon Circuit (imported WAV) | 1:12 | 6 | 2.46 s | 6.13 s |
| Hyper Spoiler | 4:32 | 17 | 2.87 s | 7.92 s |
| I Can't | 3:08 | 21 | 1.56 s | 6.11 s |
| Magna Divide | 4:16 | 17 | 2.22 s | 7.17 s |
| Siriusmo Itchy from Enthusiast | 3:33 | 16 | 2.29 s | 7.25 s |

All beat and downbeat timestamps on all five inputs exactly matched the earlier
Beat This results. Preview at the middle, section labels, gameplay, pause and
retry passed for every input. Missing LinkSeg model preserves playable beats;
cancellation during section loading discards the result. File replacement and
returning to the bundled demo do not reuse another track's sections. Inspection
returns independent copies. No uncaught page errors or unexpected network
requests occurred. ONNX logs its existing CPU-vendor/operator-placement warnings.

The timeline occupied the entire 1440 px desktop and 390 px narrow viewport
without horizontal overflow. Automated checks passed 242 unit tests, including
reference decoder/window fixtures and a synthetic frontend comparison with
independent torchaudio 2.6.0 output (maximum error below 0.005 dB). Type checking
and the production build passed. The existing engine bundle-size warning remains.
All five existing UI browser tests also passed against the isolated preview.

See [complete timings and predicted spans](section-analysis-2026-10-20.json).
Screenshots and full analysis metadata are under `output/section-analysis/`.

## Musical accuracy remains to be judged

These results establish working inference and integration, not perceptual
accuracy. There are no human section annotations for these tracks. Predictions
can be overly frequent: I Can't produced 21 raw spans in 188 seconds, and many
neighboring spans share a label. LinkSeg's pop-oriented labels do not explicitly
represent EDM builds, drops or breakdowns; instrumental music may receive verse
or chorus labels. No numeric accuracy claim is supported by this experiment.

Listen at the displayed transitions and record missed changes, extra changes,
wrong labels and early/late boundaries. Compare raw boundaries before considering
merging equal-label spans or changing the peak window. Keep high-impact gameplay
reactions separate until those listening checks establish useful behavior.

## Reproduce

Use Bun 1.4.3+ and the four private tracks already in ignored `local-audio/`:

```sh
bun install --frozen-lockfile
bun run setup:audio
bun test src/analysis src/tracks
bun run build --outDir output/linkseg-dist
bun run preview --outDir output/linkseg-dist --port 4187 --strictPort
# In a separate terminal:
bun tests/section-analysis.ts http://127.0.0.1:4187
```

The evaluation writes only local reports/screenshots. If the previous beat
reports exist under `output/audio-analysis/`, it checks exact timestamp parity.
