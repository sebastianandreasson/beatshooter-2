import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(root, "public/models");
const modelPath = resolve(destination, "beat-this.onnx");
const modelUrl = "https://github.com/jgorset/beat-this/releases/download/v1.0.0/beat-this.onnx";
const modelBytes = 83_008_106;
const modelSha256 = "5d8a94ce99fb33a6b26df6f6d8076decd52b8fd9439e3206d9b8bcdb1c2881bd";

function validModel(bytes: Uint8Array): boolean {
    return bytes.length === modelBytes &&
        createHash("sha256").update(bytes).digest("hex") === modelSha256;
}

await mkdir(destination, { recursive: true });
const existing = await readFile(modelPath).catch(() => undefined);
if (!existing || !validModel(existing)) {
    console.log("Downloading the pinned Beat This final0 model (83 MB)...");
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!validModel(bytes)) throw new Error("Model checksum or length does not match the pinned release.");
    const temporary = `${modelPath}.partial`;
    try {
        await Bun.write(temporary, bytes);
        await rename(temporary, modelPath);
    } finally {
        await rm(temporary, { force: true });
    }
}

const runtimeRoot = resolve(root, "node_modules/onnxruntime-web");
const runtimePackage = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
if (runtimePackage.version !== "1.23.2") throw new Error("Expected ONNX Runtime Web 1.23.2.");
const runtimeDestination = resolve(destination, "onnx-runtime");
await mkdir(runtimeDestination, { recursive: true });
// ONNX 1.23.2's dedicated WebGPU entry uses asyncify, not the JSEP build.
// Keep only its required pair; runtime code never comes from a third-party CDN.
for (const file of [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
]) {
    await copyFile(resolve(runtimeRoot, "dist", file), resolve(runtimeDestination, file));
}
// Remove only artifacts emitted by an earlier version of this setup.
for (const file of [
    "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
]) await rm(resolve(runtimeDestination, file), { force: true });
await copyFile(resolve(root, "node_modules/@jgorset/beat-this/LICENSE"), resolve(destination, "BEAT-THIS-LICENSE.txt"));
await copyFile(resolve(root, "node_modules/@jgorset/beat-this/THIRD_PARTY_NOTICES.md"),
    resolve(destination, "BEAT-THIS-NOTICES.md"));
const fftReadme = await readFile(resolve(root, "node_modules/fft.js/README.md"), "utf8");
const fftLicense = fftReadme.split("#### LICENSE\n")[1];
if (!fftLicense) throw new Error("Could not locate fft.js license.");
await Bun.write(resolve(destination, "FFT-LICENSE.txt"), fftLicense.trim() + "\n");
// The published ONNX Web tarball omits LICENSE; retain the notice from its
// exact source release alongside the redistributed runtime files.
const runtimeLicense = await fetch("https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/LICENSE");
if (!runtimeLicense.ok) throw new Error("Could not retrieve the pinned ONNX Runtime license.");
await Bun.write(resolve(destination, "ONNX-RUNTIME-LICENSE.txt"), await runtimeLicense.text());
console.log("Audio analysis assets ready. Model SHA-256 verified; runtime 1.23.2 copied locally.");
