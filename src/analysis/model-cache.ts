import type { ModelAsset } from "./models";

export const MODEL_CACHE_NAME = "beatshooter-models-v1";

async function verifiedBytes(response: Response, model: ModelAsset): Promise<Uint8Array<ArrayBuffer>> {
    if (response.status !== 200) throw new Error(`Could not load ${model.file}: HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== model.bytes) throw new Error(`Incomplete model: ${model.file}.`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== model.sha256) throw new Error(`Model checksum mismatch: ${model.file}.`);
    return bytes;
}

/**
 * Cache only verified, versioned model weights, never music or analysis results.
 * Cache Storage survives worker disposal/reloads. Storage denial or quota limits
 * must not prevent analysis; incomplete/corrupt downloads must never be retained.
 */
export async function loadModelBytes(url: string, model: ModelAsset): Promise<Uint8Array<ArrayBuffer>> {
    const source = new URL(url, location.href);
    if (source.origin !== location.origin) throw new Error("Models must be loaded from this application.");
    const key = new URL(source);
    key.searchParams.set("model-sha256", model.sha256);
    let cache: Cache | undefined;
    try { cache = await globalThis.caches?.open(MODEL_CACHE_NAME); } catch { /* Storage may be disabled. */ }
    if (cache) {
        try {
            const cached = await cache.match(key.href);
            if (cached) {
                try { return await verifiedBytes(cached, model); }
                catch { await cache.delete(key.href); }
            }
        } catch { /* A cache read failure can fall back to the server. */ }
    }
    // Revalidate HTTP cache only on a persistent-cache miss. The hash above
    // invalidates saved weights when a different pinned model is shipped.
    const response = await fetch(source.href, { mode: "same-origin", cache: "no-cache" });
    const bytes = await verifiedBytes(response, model);
    if (cache) {
        try {
            await cache.put(key.href, new Response(bytes, {
                headers: { "Content-Type": "application/octet-stream" },
            }));
            // Remove old versions of this model only, keeping other models and
            // all unrelated application/browser caches intact.
            for (const entry of await cache.keys()) {
                const previous = new URL(entry.url);
                if (previous.origin === source.origin && previous.pathname === source.pathname &&
                    previous.searchParams.has("model-sha256") && previous.href !== key.href) {
                    await cache.delete(entry);
                }
            }
        } catch { /* Quota/permission failures leave this download usable. */ }
    }
    return bytes;
}

/** The Beat This API accepts URLs only. Revoke this local handle after loading. */
export async function withModelUrl<T>(
    url: string, model: ModelAsset, load: (localUrl: string) => Promise<T>,
): Promise<T> {
    const bytes = await loadModelBytes(url, model);
    const localUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    try { return await load(localUrl); }
    finally { URL.revokeObjectURL(localUrl); }
}
