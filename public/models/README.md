# Local audio-analysis assets

Prepare these assets with `bun run setup:audio` after installing dependencies.
The setup downloads the pinned model, verifies its byte count and SHA-256,
and copies matching ONNX Runtime files from the installed dependency.
The large generated files are intentionally not committed.

- Browser port: [`@jgorset/beat-this` 1.0.0](https://github.com/jgorset/beat-this/tree/v1.0.0), Johannes Gorset, MIT.
- Original model/code: [Beat This!](https://github.com/CPJKU/beat_this), Francesco Foscarin, Jan Schlüter, Gerhard Widmer; Institute of Computational Perception, JKU Linz, Austria, MIT.
- Checkpoint: upstream package 1.1.0, `final0`; ONNX format export with unchanged weights, opset 17.
- Release: https://github.com/jgorset/beat-this/releases/download/v1.0.0/beat-this.onnx
- Size: **83,008,106 bytes**.
- SHA-256: `5d8a94ce99fb33a6b26df6f6d8076decd52b8fd9439e3206d9b8bcdb1c2881bd`.
- Runtime: [ONNX Runtime Web 1.23.2](https://github.com/microsoft/onnxruntime), Microsoft Corporation, MIT.
- FFT: [fft.js 4.0.4](https://github.com/indutny/fft.js), Fedor Indutny, MIT.

The model and runtime licenses accompany the prepared assets. Audio selected
by players stays in their browser. Runtime requests fetch only these same-origin
assets; the setup command downloads software/model assets, never player audio.

The WebGPU runtime requires only `ort-wasm-simd-threaded.asyncify.mjs` and its
matching `.wasm`. Vite selects ONNX's external-WASM entry so these same-origin
files are not duplicated in the generated bundle.

The browser worker uses WebGPU and mono PCM at exactly 22,050 Hz. It returns
detected beat/downbeat timestamps; they remain estimates and can need correction.

## LinkSeg section analysis

`setup:audio` also prepares `linkseg-7c.onnx` using the same local runtime.

- Original model: [LinkSeg](https://github.com/morgan76/LinkSeg), M. Buisson,
  B. McFee and S. Essid, *Using Pairwise Link Prediction and Graph Attention
  Networks for Music Structure Analysis*, ISMIR 2024.
- [ONNX model card](https://huggingface.co/elicwhite/linkseg-7c-onnx):
  CC-BY-4.0, attribution preserved here and in `LINKSEG-LICENSE.txt`.
- Model repository revision: `b15f9d9f5f68409cbd2cc0e78beb208df497c6f5`.
- File size: **1,574,039 bytes**.
- SHA-256: `c1dac2e094d260678d0097b85da6f5189abfe87af4b9c6f7adebaf99f4896125`.
- Browser frontend/decoder: [LinkSeg-web](https://github.com/elicwhite/LinkSeg-web),
  MIT, pinned to `694d27356082712dc82a3e06dbf9c7d543c9e399`; selected numerical
  files are vendored under `src/analysis/vendor/linkseg/`.

The worker reuses 22,050 Hz mono PCM and existing detected beat timestamps.
It releases Beat This before initializing LinkSeg. No audio is uploaded.
LinkSeg returns intro, verse, chorus, bridge, instrumental, outro and silence
estimates; these labels do not include EDM drops or buildups. Section metadata
does not affect the beat chart, score identity, enemy behavior or transport.
If section inference fails, the existing beat result remains playable.
