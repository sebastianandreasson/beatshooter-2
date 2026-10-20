/** Smoothed visual modulation at 20 Hz. These curves never establish beat timing. */
export interface EnergyCurve {
    version: 1;
    sampleRate: 20;
    duration: number;
    /** Normalized 0..1 RMS; samples represent the centers of 50 ms windows. */
    loudness: number[];
    /** Normalized 0..1 low-band RMS, using the same reference as loudness. */
    bass: number[];
}

/** Versioned, local-only output. All event times are seconds from file start. */
export interface BeatAnalysis {
    schemaVersion: 1;
    analyzerVersion: string;
    duration: number;
    beats: number[];
    downbeats: number[];
    elapsedMs: number;
    backend: "webgpu" | "wasm";
    /** Optional decoration only; omitted curves use a neutral visual response. */
    energy?: EnergyCurve;
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
