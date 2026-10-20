import { createBeatThis, type BeatThis } from "@jgorset/beat-this";
import {
    ANALYZER_VERSION,
    type AnalysisRequest,
    type AnalysisResponse,
} from "./types";

// Avoid mixing the window and worker TypeScript global libraries.
const scope = self as unknown as {
    onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
    postMessage: (message: AnalysisResponse) => void;
    location: Location;
    navigator: { gpu?: unknown };
};

function progress(stage: string, completed: number, total: number): void {
    scope.postMessage({ type: "progress", progress: { stage, completed, total } });
}

function validEvents(events: number[], duration: number): number[] {
    let previous = -Infinity;
    return events.filter((time) => {
        const valid = Number.isFinite(time) && time >= 0 && time < duration && time > previous;
        if (valid) previous = time;
        return valid;
    });
}

let busy = false;
scope.onmessage = async ({ data }) => {
    if (data.type !== "analyze" || busy) return;
    busy = true;
    let tracker: BeatThis | undefined;
    const started = performance.now();
    try {
        if (!scope.navigator.gpu) {
            throw new Error("Automatic analysis needs WebGPU. Use a compatible browser or manual BPM and offset.");
        }
        if (new URL(data.modelUrl).origin !== scope.location.origin ||
            new URL(data.wasmPaths).origin !== scope.location.origin) {
            throw new Error("Audio analysis assets must be served from this application.");
        }
        progress("Loading beat model", 0, 1);
        tracker = await createBeatThis({
            modelUrl: data.modelUrl,
            executionProvider: "webgpu",
            wasmPaths: data.wasmPaths,
        });
        progress("Loading beat model", 1, 1);
        const result = await tracker.analyze(data.pcm, {
            onProgress: (_stage, completed, total) => progress("Finding beats and downbeats", completed ?? 0, total ?? 1),
        });
        progress("Finding beats and downbeats", 1, 1);
        const analysis = {
            schemaVersion: 1 as const,
            analyzerVersion: ANALYZER_VERSION,
            duration: data.duration,
            beats: validEvents(result.beats, data.duration),
            downbeats: validEvents(result.downbeats, data.duration),
            elapsedMs: performance.now() - started,
            backend: "webgpu" as const,
        };
        await tracker.dispose();
        tracker = undefined;
        scope.postMessage({ type: "result", result: analysis });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Local audio analysis failed:", detail,
            "Local development setup: bun run setup:audio prepares the model and matching runtime.");
        scope.postMessage({
            type: "error",
            message: detail.startsWith("Automatic analysis needs") ? detail :
                "Automatic analysis could not finish. Try again or use manual BPM and offset.",
        });
    } finally {
        await tracker?.dispose().catch(() => {});
    }
};
