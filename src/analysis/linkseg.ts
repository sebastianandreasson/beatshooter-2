import * as ort from "onnxruntime-web/webgpu";
import { buildLinkSegWindows } from "./vendor/linkseg/windows";
import { melWindowInto } from "./vendor/linkseg/mel";
import { linksegDecode } from "./vendor/linkseg/decode";
import { SECTION_ANALYZER_VERSION, validateSections, type SectionAnalysis } from "./sections";
import { loadModelBytes } from "./model-cache";
import { SECTION_MODEL } from "./models";

/**
 * Worker-only adapter. Use our decoded PCM, our beats and our same-origin runtime.
 * Beat This is disposed before this runs; all tensors and the session are released here.
 */
export async function analyzeSections(
    pcm: Float32Array, beats: number[], duration: number, modelUrl: string,
    progress: (stage: string, completed: number, total: number) => void,
): Promise<SectionAnalysis> {
    const started = performance.now();
    if (beats.length < 4) throw new Error("At least four detected beats are needed for section analysis.");
    const { windows, beatTimes } = buildLinkSegWindows(beats, pcm);
    if (windows.length < 4) throw new Error("Too few distinct beats for section analysis.");
    const mel = new Float32Array(windows.length * 64 * 64);
    for (let i = 0; i < windows.length; i++) {
        melWindowInto(windows[i]!, mel, i * 4096);
        if (i % 16 === 0) progress("Measuring song sections", i, windows.length);
    }
    progress("Measuring song sections", windows.length, windows.length);
    progress("Loading section model", 0, 1);
    const session = await ort.InferenceSession.create(await loadModelBytes(modelUrl, SECTION_MODEL), {
        executionProviders: ["webgpu"], graphOptimizationLevel: "all",
    });
    let input: ort.Tensor | undefined;
    let outputs: ort.InferenceSession.OnnxValueMapType | undefined;
    try {
        progress("Finding song sections", 0, 1);
        input = new ort.Tensor("float32", mel, [windows.length, 1, 64, 64]);
        // Avoid copying the unused N × N × 3 pairwise output back to the CPU.
        outputs = await session.run({ mel: input }, ["bound", "label"]);
        const boundaries = outputs.bound!.data as Float32Array;
        const labels = outputs.label!.data as Float32Array;
        if (boundaries.length !== windows.length - 1 || labels.length !== windows.length * 7 ||
            !boundaries.every(Number.isFinite) || !labels.every(Number.isFinite)) {
            throw new Error("Invalid section model output.");
        }
        const decoded = linksegDecode(boundaries, labels, beatTimes, duration, 7, 8, 8, 0);
        const result = validateSections({
            version: 1, analyzerVersion: SECTION_ANALYZER_VERSION, duration,
            elapsedMs: performance.now() - started, backend: "webgpu",
            sections: decoded.labels.map((label, i) => ({
                start: decoded.times[i], end: decoded.times[i + 1], label,
            })),
        }, duration);
        if (!result) throw new Error("Invalid section timeline.");
        progress("Finding song sections", 1, 1);
        return result;
    } finally {
        input?.dispose();
        for (const tensor of Object.values(outputs ?? {})) tensor.dispose();
        await session.release();
    }
}
