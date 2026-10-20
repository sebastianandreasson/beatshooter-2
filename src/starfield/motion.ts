import { validateSections, type SectionAnalysis } from "../analysis/sections";
import type { Beat } from "../rhythm/timeline";
import { SectionTransitionTimeline } from "../section-effects/state";

export interface StarfieldMotionFrame {
    /** Integrated travel in the renderer's original distance units, including completed boosts. */
    distance: number;
    /** Instantaneous travel speed: five normally, 125 at the boost peak. */
    speed: number;
    boost: number;
}

interface BoostSegment {
    start: number;
    end: number;
    startProgress: number;
    progressRate: number;
    extraBefore: number;
    extraAfter: number;
}

export const STAR_BASE_SPEED = 5;
export const STAR_HYPERSPACE_MULTIPLIER = 25;
const EXTRA_SPEED = STAR_BASE_SPEED * (STAR_HYPERSPACE_MULTIPLIER - 1);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Integral of sin²(πp), with respect to musical progress p. */
const integratedEnvelope = (progress: number): number =>
    progress / 2 - Math.sin(2 * Math.PI * progress) / (4 * Math.PI);

function firstBeatAfter(beats: readonly Beat[], position: number): number {
    let low = 0, high = beats.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (beats[middle]!.time <= position) low = middle + 1;
        else high = middle;
    }
    return low;
}

/**
 * Absolute song-time motion. Integrating the boost once prevents the jumps that
 * multiplying song position by the current speed would create. Musical progress
 * is linear between actual beat timestamps, so each segment has an exact integral.
 * Samples are stateless: pause, slowdown, seek and retry need no accumulated delta.
 */
export class StarfieldTimeline {
    private readonly segments: readonly BoostSegment[];

    constructor(structure: SectionAnalysis | undefined, beats: readonly Beat[]) {
        const segments: BoostSegment[] = [];
        this.segments = segments;
        const analysis = structure && validateSections(structure, structure.duration);
        // Dojo and tracks without analysis do not need a duplicate long beat cache.
        if (!analysis || analysis.sections.length < 2) return;
        const timeline = new SectionTransitionTimeline(analysis, beats);
        let extraDistance = 0;
        for (const section of analysis.sections.slice(1)) {
            const transition = timeline.sample(section.start);
            if (!transition.active || !transition.musical) continue;
            let start = transition.startTime;
            let startProgress = 0;
            let beatIndex = firstBeatAfter(beats, start);
            while (start < transition.endTime) {
                const beat = beats[beatIndex];
                const end = beat && beat.time < transition.endTime ? beat.time : transition.endTime;
                // The endpoint can also begin another section, whose sampled progress
                // is zero. The current transition always finishes at progress one.
                const endProgress = end === transition.endTime ? 1 : timeline.sample(end).progress;
                const progressRate = (endProgress - startProgress) / (end - start);
                const extra = EXTRA_SPEED *
                    (integratedEnvelope(endProgress) - integratedEnvelope(startProgress)) / progressRate;
                segments.push({
                    start, end, startProgress, progressRate,
                    extraBefore: extraDistance,
                    extraAfter: extraDistance + extra,
                });
                extraDistance += extra;
                start = end;
                startProgress = endProgress;
                beatIndex++;
            }
        }
    }

    sample(position: number): StarfieldMotionFrame {
        const time = Number.isFinite(position) ? Math.max(0, position) : 0;
        let low = 0, high = this.segments.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.segments[middle]!.start <= time) low = middle + 1;
            else high = middle;
        }
        const segment = this.segments[low - 1];
        const base = time * STAR_BASE_SPEED;
        if (!segment) return { distance: base, speed: STAR_BASE_SPEED, boost: 0 };
        if (time >= segment.end) {
            return { distance: base + segment.extraAfter, speed: STAR_BASE_SPEED, boost: 0 };
        }
        const progress = clamp01(segment.startProgress + (time - segment.start) * segment.progressRate);
        const boost = Math.sin(Math.PI * progress) ** 2;
        const partialExtra = EXTRA_SPEED *
            (integratedEnvelope(progress) - integratedEnvelope(segment.startProgress)) / segment.progressRate;
        return {
            distance: base + segment.extraBefore + partialExtra,
            speed: STAR_BASE_SPEED + EXTRA_SPEED * boost,
            boost,
        };
    }
}
