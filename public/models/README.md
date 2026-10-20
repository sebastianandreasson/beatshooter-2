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
