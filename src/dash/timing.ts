import type { Beat } from "../rhythm/timeline";

export const DASH_WINDOW_SECONDS = 0.15;

export interface DashCandidate {
    beatIndex: number;
    bar: number;
    beatInBar: number;
    time: number;
    beatDuration: number;
}

export interface DashTiming {
    candidate(position: number): DashCandidate | undefined;
    barAt(position: number): number | undefined;
}

const EPSILON = 1e-9;
const MIN_INTERVAL = 0.12;
const MAX_INTERVAL = 3;

function nearbyDuration(beats: readonly Beat[], index: number): number {
    // Prefer the tempo leaving this beat, then the incoming tempo. A gap
    // does not turn into a multi-second dash: search only four local intervals
    // on either side before using the neutral duration.
    for (let distance = 0; distance < 4; distance++) {
        for (const start of [index + distance, index - 1 - distance]) {
            if (start < 0 || start + 1 >= beats.length) continue;
            const duration = beats[start + 1]!.time - beats[start]!.time;
            if (Number.isFinite(duration) &&
                duration >= MIN_INTERVAL - EPSILON && duration <= MAX_INTERVAL + EPSILON) {
                return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, duration));
            }
        }
    }
    return 0.5;
}

/**
 * Cache the chart's actual beats and bar identities, including detected timing.
 * Callers own session phase and one-use-per-bar consumption. The last authored
 * beat keeps its usual bounded window; no beats are extrapolated into gaps.
 */
export function createDashTiming(beats: readonly Beat[]): DashTiming {
    const candidates: DashCandidate[] = [];
    for (let index = 0; index < beats.length; index++) {
        const beat = beats[index]!;
        candidates.push({
            beatIndex: beat.index,
            bar: beat.bar,
            beatInBar: beat.beatInBar,
            time: beat.time,
            beatDuration: nearbyDuration(beats, index),
        });
    }
    const firstAtOrAfter = (position: number): number => {
        let low = 0, high = candidates.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (candidates[middle]!.time < position) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    return {
        candidate(position) {
            if (!Number.isFinite(position) || position < 0 || candidates.length === 0) return;
            const index = firstAtOrAfter(position);
            const previous = candidates[index - 1], next = candidates[index];
            // A tie belongs to the earlier beat, independent of render rate.
            const nearest = previous && (!next ||
                position - previous.time <= next.time - position + EPSILON) ? previous : next;
            if (nearest && Math.abs(position - nearest.time) <= DASH_WINDOW_SECONDS + EPSILON) {
                // The caller cannot mutate our cached metadata through a result.
                return { ...nearest };
            }
        },
        barAt(position) {
            if (!Number.isFinite(position) || position < 0) return;
            const index = firstAtOrAfter(position);
            return (candidates[index]?.time === position ? candidates[index] : candidates[index - 1])?.bar;
        },
    };
}
