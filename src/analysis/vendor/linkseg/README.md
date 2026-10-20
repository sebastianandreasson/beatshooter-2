# Pinned LinkSeg numerical frontend and decoder

Source: https://github.com/elicwhite/LinkSeg-web/tree/694d27356082712dc82a3e06dbf9c7d543c9e399

Only `windows.ts`, `mel.ts`, `fft-radix2.ts`, `decode.ts`, and `mel-fb.json`
are included. The browser package is not available from npm at the time of
integration. Its model-loading, caching, resampling, UI and demo audio are not
included. The game owns asset verification, worker lifetime and ONNX sessions.

Numerical code is unchanged. Each TypeScript file has one added `@ts-nocheck`
header because upstream does not use this project's strict indexed-access checks.
The pure frontend and decoder are covered by independent reference tests.
Do not casually refactor numerical code without rerunning those comparisons.

Upstream's MIT license is retained in `LICENSE`. The model is attributed to
M. Buisson, B. McFee and S. Essid, *Using Pairwise Link Prediction and Graph
Attention Networks for Music Structure Analysis*, ISMIR 2024.
The ONNX publisher declares the weights CC-BY-4.0.
See `public/models/README.md` for pinned model provenance.

The two upstream fixtures under `tests/fixtures/linkseg/` contain beat positions
and model activations, not audio. The mel fixture there is independently
generated from a deterministic synthetic signal with torchaudio 2.6.0.
