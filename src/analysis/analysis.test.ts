import { afterEach, expect, test } from "bun:test";
import { analyzeAudio, prepareAnalysisAudio } from "./index";
import type { AnalysisRequest, AnalysisResponse } from "./types";

const originals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(name: string, value: unknown): void {
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

function audio(channels = 2, sampleRate = 48_000, length = 48_000): AudioBuffer {
    return { numberOfChannels: channels, sampleRate, length, duration: length / sampleRate } as AudioBuffer;
}

function fakeRenderer(pending = false) {
    const state = {
        channels: 0, samples: 0, rate: 0, disconnected: 0,
        gains: [] as number[], input: undefined as AudioBuffer | undefined,
        finish: (() => {}) as () => void,
    };
    replaceGlobal("OfflineAudioContext", class {
        destination = {};
        constructor(channels: number, samples: number, rate: number) {
            Object.assign(state, { channels, samples, rate });
        }
        createBufferSource() {
            return {
                set buffer(value: AudioBuffer) { state.input = value; },
                connect() {}, start() {},
                disconnect() { state.disconnected++; },
            };
        }
        createChannelSplitter() { return { connect() {}, disconnect() {} }; }
        createGain() {
            return {
                gain: { set value(value: number) { state.gains.push(value); } },
                connect() {},
            };
        }
        startRendering(): Promise<AudioBuffer> {
            return new Promise((resolve) => {
                state.finish = () => resolve({
                    getChannelData: () => new Float32Array(state.samples),
                } as unknown as AudioBuffer);
                if (!pending) state.finish();
            });
        }
    });
    return state;
}

class FakeWorker {
    static instance: FakeWorker;
    onmessage: ((event: MessageEvent<AnalysisResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    request?: AnalysisRequest;
    transfers: Transferable[] = [];
    terminated = 0;
    constructor() { FakeWorker.instance = this; }
    postMessage(request: AnalysisRequest, transfers: Transferable[]) {
        this.request = request;
        this.transfers = transfers;
    }
    terminate() { this.terminated++; }
    receive(data: AnalysisResponse) { this.onmessage?.({ data } as MessageEvent<AnalysisResponse>); }
}
function fakeWorkers() {
    replaceGlobal("Worker", FakeWorker);
    replaceGlobal("location", { href: "http://localhost:4174/" });
}

test("preprocessing requests exact 22,050 Hz mono and averages every channel", async () => {
    const state = fakeRenderer();
    const input = audio(6, 48_000, 48_001);
    const output = await prepareAnalysisAudio(input);
    expect(state.input).toBe(input);
    expect(state.channels).toBe(1);
    expect(state.rate).toBe(22_050);
    expect(output.length).toBe(22_051);
    expect(state.gains).toEqual(Array(6).fill(1 / 6));
    expect(state.disconnected).toBe(1);
    expect(input.length).toBe(48_001);
});

test("already cancelled analysis does not allocate preprocessing or a worker", async () => {
    const signal = AbortSignal.abort();
    replaceGlobal("OfflineAudioContext", class {
        constructor() { throw new Error("Should not allocate"); }
    });
    await expect(analyzeAudio(audio(), { signal })).rejects.toMatchObject({ name: "AbortError" });
});

test("cancel during native resampling rejects before rendering finishes", async () => {
    const state = fakeRenderer(true);
    const controller = new AbortController();
    const pending = prepareAnalysisAudio(audio(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.disconnected).toBe(1);
    state.finish();
});

test("analysis transfers separate mono PCM and terminates its worker after completion", async () => {
    fakeRenderer();
    fakeWorkers();
    const input = audio();
    const pending = analyzeAudio(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = FakeWorker.instance;
    expect(worker.request?.pcm.length).toBe(22_050);
    expect(worker.transfers).toEqual([worker.request!.pcm.buffer]);
    expect(worker.request?.modelUrl).toBe("http://localhost:4174/models/beat-this.onnx");
    worker.receive({ type: "result", result: {
        schemaVersion: 1, analyzerVersion: "fixture", duration: 1,
        beats: [0.2, 0.7], downbeats: [0.2], elapsedMs: 1, backend: "webgpu",
    } });
    const result = await pending;
    expect(result.beats).toEqual([0.2, 0.7]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(worker.terminated).toBe(1);
});

test("cancellation terminates an in-flight worker and ignores a late response", async () => {
    fakeRenderer();
    fakeWorkers();
    const controller = new AbortController();
    const pending = analyzeAudio(audio(), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = FakeWorker.instance;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    worker.receive({ type: "error", message: "Late failure" });
    expect(worker.terminated).toBe(1);
});

test("worker failure rejects with a recoverable message and frees the worker", async () => {
    fakeRenderer();
    fakeWorkers();
    const pending = analyzeAudio(audio());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = FakeWorker.instance;
    worker.receive({ type: "error", message: "Try manual BPM and offset." });
    await expect(pending).rejects.toThrow("manual BPM");
    expect(worker.terminated).toBe(1);
});
