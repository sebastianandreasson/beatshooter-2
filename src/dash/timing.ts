import type { Beat } from "../rhythm/timeline";

export const DASH_WINDOW_SECONDS = 0.1;

export interface DashCandidate {
    beatIndex: number;
    time: number;
    beatDuration: number;
}

export interface DashTiming {
    candidate(position: number): DashCandidate | undefined;
}

const EPSILON = 1e-9;
const MIN_INTERVAL = 0.12;
const MAX_INTERVAL = 3;

function nearbyDuration(beats: readonly Beat[], index: number): number {
    // Prefer the tempo leaving this downbeat, then the incoming tempo. A gap
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
 * Cache a validated chart's authored accents. Inferred bar boundaries never
 * grant a dash; callers own session phase and once-per-downbeat consumption.
 * Without a track duration, the last authored downbeat keeps its usual window.
 */
export function createDashTiming(beats: readonly Beat[]): DashTiming {
    const downbeats: DashCandidate[] = [];
    for (let index = 0; index < beats.length; index++) {
        const beat = beats[index]!;
        if (beat.downbeat) downbeats.push({
            beatIndex: beat.index,
            time: beat.time,
            beatDuration: nearbyDuration(beats, index),
        });
    }
    return {
        candidate(position) {
            if (!Number.isFinite(position) || position < 0 || downbeats.length === 0) return;
            let low = 0, high = downbeats.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (downbeats[middle]!.time < position) low = middle + 1;
                else high = middle;
            }
            const previous = downbeats[low - 1], next = downbeats[low];
            // A tie belongs to the earlier accent, independent of render rate.
            const nearest = previous && (!next ||
                position - previous.time <= next.time - position + EPSILON) ? previous : next;
            if (nearest && Math.abs(position - nearest.time) <= DASH_WINDOW_SECONDS + EPSILON) {
                // The caller cannot mutate our cached metadata through a result.
                return { ...nearest };
            }
        },
    };
}
