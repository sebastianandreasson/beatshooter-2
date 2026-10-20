import { beatAtPosition, type Beat } from "../rhythm/timeline";

/**
 * Stop after 100–140 ms of music, on a subdivision of the authored beat.
 * The 1 → 0.12 playback ramp makes that about 180–250 ms of real time.
 * Slow tempos use a finer musical fraction, not a longer interruption.
 * A missing detection or song tail gets a short fade without invented beats.
 */
export function levelUpPauseTarget(beats: readonly Beat[], position: number, duration: number): number {
    const current = beatAtPosition(beats, position);
    const index = current?.index ?? 0;
    const earliest = position + 0.1;
    const latest = Math.min(duration, position + 0.14);
    for (let i = index; i + 1 < beats.length && beats[i]!.time <= latest; i++) {
        const start = beats[i]!.time, length = beats[i + 1]!.time - start;
        if (length < 0.12 || length > 3.05) continue;
        const divisions = 2 ** Math.ceil(Math.log2(length / 0.04));
        const spacing = length / divisions;
        const step = Math.max(0, Math.ceil((earliest - start) / spacing - 1e-8));
        const target = start + step * spacing;
        if (step <= divisions && target >= earliest - 1e-8 && target <= latest + 1e-8) return target;
    }
    return Math.min(duration, position + 0.1);
}
