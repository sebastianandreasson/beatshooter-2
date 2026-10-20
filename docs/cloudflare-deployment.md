# Cloudflare deployment

This deployment uses the personal account selected in `wrangler.jsonc` and
publishes the `beatshooter-2` Worker on its Cloudflare-provided `workers.dev`
address.

Live site: https://beatshooter-2.sebastian-andreasson93.workers.dev

## Deploy again

Use Bun 1.4.3 or newer:

```sh
bun install --frozen-lockfile
bun run setup:audio
bunx wrangler@4.151.3 login --use-keyring
bun check
bun test
bun run deploy
```

`setup:audio` prepares the pinned model and runtime binaries on a fresh checkout.
Login is only needed when Wrangler is not already authenticated. `bun run deploy`
builds the current working tree, verifies the models, prepares deployment assets
and uploads them with pinned Wrangler 4.151.3.

To build and inspect without publishing:

```sh
bun run build:cloudflare
bunx wrangler@4.151.3 deploy --dry-run
```

## Large model delivery

Cloudflare limits individual static assets to 25 MiB. The build preparation
script splits the 83,008,106-byte Beat This model into four files, each at most
20 MiB, and verifies that concatenating them reproduces its pinned SHA-256.
The generated files live under `.artifacts/cloudflare/assets`, outside Git.
All other assets are also checked against the hosting limit.

The original `/models/beat-this.onnx` URL redirects to a small JSON manifest.
The browser downloads the same-origin parts in order into one model buffer,
checks their declared lengths and verifies the complete model's SHA-256 before
inference or persistence. An existing full-model cache entry remains usable.
Local development and other hosts can still serve the original single binary.

All delivery is static, including the game, music, models and ONNX runtime.
R2 and custom Worker execution are not required. Imported music and saved
campaigns remain in browser storage.

The existing `public/_headers` configures COOP/COEP on static responses.
Missing files retain a 404 response rather than receiving the game HTML.

References: [Cloudflare asset limits](https://developers.cloudflare.com/workers/platform/limits/),
[static redirects](https://developers.cloudflare.com/workers/static-assets/redirects/),
and [response headers](https://developers.cloudflare.com/workers/static-assets/headers/).

## Live verification

After deployment, check the actual HTTPS origin:

```sh
bun scripts/verify-cloudflare.ts
```

This exercises the actual browser model loader three times without persistent
cache reuse. The initial deployment tried joining the parts in a Worker, which
exceeded its CPU limit and truncated responses. A cold download passed before
repeated downloads exposed the problem. Static delivery removes that execution
path entirely.

- The game document has `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`; `crossOriginIsolated` is true.
- The menu and demo start in a WebGPU-capable browser.
- The model loader reconstructs exactly 83,008,106 bytes with SHA-256
  `5d8a94ce99fb33a6b26df6f6d8076decd52b8fd9439e3206d9b8bcdb1c2881bd`.
- The runtime `.mjs` is served as JavaScript and `.wasm` as WebAssembly.
- Importing audio can initialize the real inference worker and finish analysis.

Browser storage belongs to the site origin. A music library or checkpoint on
localhost does not automatically appear on the Cloudflare URL. Use the game's
recovery export/import and relink the original recordings to move saved data.
The human headphone/display latency check in `release-smoke.md` remains separate.

## Verification record — 2026-10-20

- Deployment version: `6934c92a-e7ff-4349-b5b5-837722dced88`.
- Bun 1.4.3: production build, type check and all 457 unit tests passed.
- Three production-browser smoke tests passed: startup rendering, asset/isolation
  headers, and the unsupported-WebGPU message.
- Three consecutive live downloads through the actual model loader each
  reconstructed 83,008,106 bytes with the pinned SHA-256.
- Live Chrome reported a secure context, WebGPU and cross-origin isolation.
- Importing the bundled 72-second WAV through the live UI completed real beat
  and section inference: 120 BPM and 7 predicted sections.
- The analyzed track started through the upgrade/count-in flow and reached
  normal game-over results after 12 seconds (150 points, one elimination).
- ONNX emitted its existing CPU-vendor/provider-assignment warnings; inference
  completed successfully. The earlier incomplete-model failure no longer occurred.
