import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { BEAT_MODEL, SECTION_MODEL } from "../src/analysis/models";
import { chunkBytes, modelParts, modelPath } from "../cloudflare/model";

const root = resolve(import.meta.dir, "..");
const built = resolve(root, "dist");
const destination = resolve(root, ".artifacts/cloudflare/assets");
const modelFile = resolve(built, "models", BEAT_MODEL.file);

// Refuse to publish a game with missing, stale or corrupted inference assets.
for (const model of [BEAT_MODEL, SECTION_MODEL]) {
    const bytes = await Bun.file(resolve(built, "models", model.file)).bytes();
    if (bytes.length !== model.bytes || createHash("sha256").update(bytes).digest("hex") !== model.sha256) {
        throw new Error(`Invalid ${model.file}. Run bun run setup:audio before deploying.`);
    }
}
for (const extension of ["mjs", "wasm"]) {
    await stat(resolve(built, `models/onnx-runtime/ort-wasm-simd-threaded.asyncify.${extension}`));
}

await rm(destination, { recursive: true, force: true });
await cp(built, destination, { recursive: true, filter: source => source !== modelFile });
const model = Bun.file(modelFile);
for (const [index, part] of modelParts.entries()) {
    const target = resolve(destination, `.${part}`);
    await mkdir(resolve(target, ".."), { recursive: true });
    const bytes = await model.slice(index * chunkBytes, (index + 1) * chunkBytes).arrayBuffer();
    await Bun.write(target, bytes);
}
const reconstructed = createHash("sha256");
for (const part of modelParts) {
    reconstructed.update(await Bun.file(resolve(destination, `.${part}`)).bytes());
}
if (reconstructed.digest("hex") !== BEAT_MODEL.sha256) throw new Error("Model parts failed reconstruction.");
await Bun.write(resolve(destination, "models/beat-this.parts.json"), JSON.stringify({
    version: 1,
    bytes: BEAT_MODEL.bytes,
    sha256: BEAT_MODEL.sha256,
    parts: modelParts.map((url, index) => ({
        url,
        bytes: Math.min(chunkBytes, BEAT_MODEL.bytes - index * chunkBytes),
    })),
}));
await Bun.write(resolve(destination, "_redirects"), `${modelPath} /models/beat-this.parts.json 302\n`);
for (const relative of await readdir(destination, { recursive: true })) {
    const file = await stat(resolve(destination, relative));
    if (file.isFile() && file.size > 25 * 1024 * 1024) {
        throw new Error(`Cloudflare static asset exceeds 25 MiB: ${relative}`);
    }
}
console.log(`Cloudflare assets ready; verified model split into ${modelParts.length} static parts.`);
