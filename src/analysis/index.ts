import {
    ANALYSIS_SAMPLE_RATE,
    type AnalysisOptions,
    type AnalysisRequest,
    type AnalysisResponse,
    type BeatAnalysis,
} from "./types";

export type { AnalysisOptions, AnalysisProgress, BeatAnalysis } from "./types";
export { ANALYZER_VERSION } from "./types";

function aborted(): DOMException {
    return new DOMException("Audio analysis cancelled.", "AbortError");
}

function assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw aborted();
}

/**
 * Decode is owned by tracks. This produces a separate, antialiased mono signal;
 * the playback AudioBuffer is never detached or modified.
 */
export async function prepareAnalysisAudio(
    buffer: AudioBuffer,
    options: AnalysisOptions = {},
): Promise<Float32Array> {
    assertActive(options.signal);
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 ||
        !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 ||
        !Number.isSafeInteger(buffer.length) || buffer.length < 1 ||
        !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) {
        throw new Error("Choose a nonempty, decodable audio file to analyze.");
    }
    options.onProgress?.({ stage: "Preparing audio", completed: 0, total: 1 });
    const sampleCount = Math.ceil(buffer.length * ANALYSIS_SAMPLE_RATE / buffer.sampleRate);
    const renderer = new OfflineAudioContext(1, sampleCount, ANALYSIS_SAMPLE_RATE);
    const source = renderer.createBufferSource();
    source.buffer = buffer;
    // Explicit arithmetic mean for every channel, including multichannel files.
    // Native graph processing avoids another full-rate PCM copy or a long UI loop.
    const channels = renderer.createChannelSplitter(buffer.numberOfChannels);
    source.connect(channels);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const gain = renderer.createGain();
        gain.gain.value = 1 / buffer.numberOfChannels;
        channels.connect(gain, channel);
        gain.connect(renderer.destination);
    }
    source.start(0);
    try {
        // Offline rendering cannot be interrupted in every browser. Reject
        // promptly on cancellation, then release its source once rendering ends.
        const rendering = renderer.startRendering();
        const mono = await withAbort(rendering, options.signal);
        assertActive(options.signal);
        options.onProgress?.({ stage: "Preparing audio", completed: 1, total: 1 });
        return mono.getChannelData(0);
    } finally {
        source.disconnect();
        channels.disconnect();
    }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(aborted());
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
}

/**
 * Analyze a local decoded track in an isolated worker. The only fetches are
 * same-origin model/runtime assets; PCM is transferred locally, never uploaded.
 * Abort terminates inference immediately, including an in-flight GPU window.
 */
export async function analyzeAudio(
    buffer: AudioBuffer,
    options: AnalysisOptions = {},
): Promise<BeatAnalysis> {
    const started = performance.now();
    const pcm = await prepareAnalysisAudio(buffer, options);
    assertActive(options.signal);
    return new Promise<BeatAnalysis>((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        } catch {
            reject(new Error("Audio analysis could not start. Try again or use manual BPM and offset."));
            return;
        }
        let settled = false;
        const finish = (error?: Error, result?: BeatAnalysis) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", cancel);
            worker.terminate();
            if (error) reject(error);
            else if (result) resolve({ ...result, elapsedMs: performance.now() - started });
        };
        const cancel = () => finish(aborted());
        options.signal?.addEventListener("abort", cancel, { once: true });
        worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
            if (settled) return;
            const message = event.data;
            if (message.type === "progress") options.onProgress?.(message.progress);
            else if (message.type === "result") finish(undefined, message.result);
            else if (message.type === "error") finish(new Error(message.message));
        };
        worker.onerror = (event) => {
            event.preventDefault();
            finish(new Error("Audio analysis stopped unexpectedly. Try again or use manual BPM and offset."));
        };
        worker.onmessageerror = () => finish(new Error("Could not read the audio analysis. Try again."));
        if (options.signal?.aborted) {
            cancel();
            return;
        }
        const request: AnalysisRequest = {
            type: "analyze",
            pcm,
            duration: buffer.duration,
            modelUrl: new URL("/models/beat-this.onnx", location.href).href,
            sectionModelUrl: new URL("/models/linkseg-7c.onnx", location.href).href,
            wasmPaths: new URL("/models/onnx-runtime/", location.href).href,
        };
        try {
            worker.postMessage(request, [pcm.buffer]);
        } catch {
            finish(new Error("Could not prepare this audio for analysis. Try a shorter file or manual BPM."));
        }
    });
}
