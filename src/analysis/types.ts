/** Versioned, local-only output. All event times are seconds from file start. */
export interface BeatAnalysis {
    schemaVersion: 1;
    analyzerVersion: string;
    duration: number;
    beats: number[];
    downbeats: number[];
    elapsedMs: number;
    backend: "webgpu" | "wasm";
}

export interface AnalysisProgress {
    stage: string;
    completed: number;
    total: number;
}

export interface AnalysisOptions {
    signal?: AbortSignal;
    onProgress?: (progress: AnalysisProgress) => void;
}

export interface AnalysisRequest {
    type: "analyze";
    pcm: Float32Array;
    duration: number;
    modelUrl: string;
    wasmPaths: string;
}

export type AnalysisResponse =
    | { type: "progress"; progress: AnalysisProgress }
    | { type: "result"; result: BeatAnalysis }
    | { type: "error"; message: string };

export const ANALYSIS_SAMPLE_RATE = 22_050;
export const ANALYZER_VERSION = "beat-this-1.0.0-final0-v1";
