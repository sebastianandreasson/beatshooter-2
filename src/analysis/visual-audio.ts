import { prepareAnalysisAudio } from "./index";
import type { EnergyCurve } from "./types";

/** Bundled/manual tracks get the same DSP as imports, without loading an AI model. */
export async function analyzeVisualAudio(buffer: AudioBuffer, signal: AbortSignal): Promise<EnergyCurve | undefined> {
    if (typeof Worker === "undefined" || !Number.isFinite(buffer.sampleRate)) return;
    let worker: Worker | undefined;
    try {
        const pcm = await prepareAnalysisAudio(buffer, { signal });
        if (signal.aborted) return;
        worker = new Worker(new URL("./visual-worker.ts", import.meta.url), { type: "module" });
        return await new Promise<EnergyCurve | undefined>(resolve => {
            const finish = (energy?: EnergyCurve) => {
                signal.removeEventListener("abort", cancel);
                resolve(energy);
            };
            const cancel = () => finish();
            signal.addEventListener("abort", cancel, { once: true });
            worker!.onmessage = (event: MessageEvent<{ energy?: EnergyCurve }>) => finish(event.data.energy);
            worker!.onerror = event => { event.preventDefault(); finish(); };
            worker!.onmessageerror = () => finish();
            try { worker!.postMessage(pcm, [pcm.buffer]); }
            catch { finish(); }
        });
    } catch {
        // Visual metadata is optional; a playable track must remain playable.
        return;
    } finally {
        worker?.terminate();
    }
}
