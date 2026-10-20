import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadModelBytes, MODEL_CACHE_NAME, withModelUrl } from "./model-cache";
import type { ModelAsset } from "./models";

const originals = new Map<string, PropertyDescriptor | undefined>();
const nativeFetch = globalThis.fetch;
function replaceGlobal(name: string, value: unknown) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
});

const source = "https://game.example/models/fixture.onnx";
function descriptor(bytes: Uint8Array): ModelAsset {
    return { file: "fixture.onnx", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function fixture() {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const model = descriptor(bytes);
    const entries = new Map<string, Response>();
    const key = (request: string | Request) => typeof request === "string" ? request : request.url;
    const cache = {
        async match(request: string | Request) { return entries.get(key(request))?.clone(); },
        async put(request: string | Request, response: Response) { entries.set(key(request), response.clone()); },
        async delete(request: string | Request) { return entries.delete(key(request)); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
    };
    const requests: string[] = [];
    replaceGlobal("location", new URL("https://game.example/"));
    replaceGlobal("caches", { async open(name: string) { expect(name).toBe(MODEL_CACHE_NAME); return cache; } });
    replaceGlobal("fetch", async (url: string) => { requests.push(url); return new Response(bytes); });
    return { bytes, model, entries, cache, requests };
}

test("a verified model is reused across independent loads without another fetch", async () => {
    const f = fixture();
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    // Each call opens storage afresh, just as a new worker/page would.
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    expect(f.requests).toEqual([source]);
    expect(f.entries.size).toBe(1);
    expect([...f.entries.keys()][0]).toContain(f.model.sha256);
});

test("a changed model hash downloads new weights and prunes only that model's old version", async () => {
    const f = fixture();
    await loadModelBytes(source, f.model);
    const unrelated = "https://game.example/models/other.onnx?model-sha256=other";
    f.entries.set(unrelated, new Response("other"));
    const updated = new Uint8Array([4, 3, 2, 1]);
    replaceGlobal("fetch", async () => { f.requests.push(source); return new Response(updated); });
    expect(await loadModelBytes(source, descriptor(updated))).toEqual(updated);
    expect(f.requests.length).toBe(2);
    expect(f.entries.size).toBe(2);
    expect(f.entries.has(unrelated)).toBe(true);
    expect([...f.entries.keys()].some(key => key.includes(f.model.sha256))).toBe(false);
});

test("corrupt saved bytes are discarded and fetched again, including same-length corruption", async () => {
    const f = fixture();
    await loadModelBytes(source, f.model);
    f.entries.set([...f.entries.keys()][0]!, new Response(new Uint8Array([9, 9, 9, 9])));
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    expect(f.requests.length).toBe(2);
    expect(new Uint8Array(await [...f.entries.values()][0]!.arrayBuffer())).toEqual(f.bytes);
});

test("HTTP failures, truncated bodies and wrong checksums are never cached", async () => {
    const f = fixture();
    for (const response of [
        new Response("missing", { status: 404 }),
        new Response(new Uint8Array([1, 2])),
        new Response(new Uint8Array([9, 9, 9, 9])),
        new Response(new ReadableStream({ start(controller) { controller.error(new Error("Disconnected")); } })),
    ]) {
        replaceGlobal("fetch", async () => response);
        await expect(loadModelBytes(source, f.model)).rejects.toThrow();
        expect(f.entries.size).toBe(0);
    }
    replaceGlobal("fetch", async () => new Response(f.bytes));
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    expect(f.entries.size).toBe(1);
});

test("disabled storage and quota failures still allow a valid model to load", async () => {
    const f = fixture();
    f.cache.put = async () => { throw new DOMException("Full", "QuotaExceededError"); };
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    replaceGlobal("caches", { async open() { throw new DOMException("Denied", "SecurityError"); } });
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    replaceGlobal("caches", undefined);
    expect(await loadModelBytes(source, f.model)).toEqual(f.bytes);
    expect(f.requests.length).toBe(3);
    expect(f.entries.size).toBe(0);
});

test("cross-origin models are rejected before network or storage access", async () => {
    const f = fixture();
    await expect(loadModelBytes("https://other.example/model.onnx", f.model)).rejects.toThrow("this application");
    expect(f.requests).toEqual([]);
    expect(f.entries.size).toBe(0);
});

test("the Beat This local URL contains cached bytes and is revoked on success and failure", async () => {
    const f = fixture();
    for (const fail of [false, true]) {
        let localUrl = "";
        const pending = withModelUrl(source, f.model, async url => {
            localUrl = url;
            const response = await nativeFetch(url);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes);
            if (fail) throw new Error("Model initialization failed");
            return "tracker";
        });
        if (fail) await expect(pending).rejects.toThrow("Model initialization failed");
        else expect(await pending).toBe("tracker");
        await expect(nativeFetch(localUrl)).rejects.toThrow();
    }
    expect(f.requests.length).toBe(1);
});
