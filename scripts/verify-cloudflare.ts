import { createHash } from "node:crypto";
import { BEAT_MODEL } from "../src/analysis/models";
import { loadModelBytes } from "../src/analysis/model-cache";
import { modelPath } from "../cloudflare/model";

const origin = process.argv[2] ?? "https://beatshooter-2.sebastian-andreasson93.workers.dev";
// Repeat against warmed edge caches: a single cold download can pass despite
// later downloads exceeding the Worker's CPU limit.
for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(new URL(modelPath, origin), { cache: "no-cache" });
    if (response.status !== 200 || !response.body) throw new Error(`Model HTTP ${response.status}`);
    if (response.headers.get("Cross-Origin-Embedder-Policy") !== "require-corp") {
        throw new Error("Model response is missing isolation headers.");
    }
    await response.body.cancel();
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(origin) });
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    const bytes = await loadModelBytes(new URL(modelPath, origin).href, BEAT_MODEL);
    if (createHash("sha256").update(bytes).digest("hex") !== BEAT_MODEL.sha256) throw new Error("Model hash mismatch.");
    console.log(`Download ${attempt}: ${bytes.length} bytes, SHA-256 verified.`);
}
