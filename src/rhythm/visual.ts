import type { Beat } from "./timeline";

export interface MusicalFrame {
    position: number;
    beatIndex: number;
    beatPhase: number;
    beatCoordinate: number;
    /** Actual interval when usable; a local decay duration during gaps/end. */
    beatDuration: number;
    barIndex: number;
    barPhase: number;
    barCoordinate: number;
    beatPulse: number;
    downbeatPulse: number;
    /** Whether this interval supports new interpolated musical accents. */
    active: boolean;
    strength: number;
}

export interface MusicalAge {
    beats: number;
    seconds: number;
    /** Per-effect gap fade; feedback born inside a gap starts visibly at one. */
    strength: number;
}

interface Interval {
    duration: number;
    normalDuration: number;
    usable: boolean;
    quietSince: number;
    barSize: number;
    accentedBar: boolean;
}

const MIN_INTERVAL = 0.12;
const MAX_INTERVAL = 3.05; // Includes the supported 20 BPM boundary.
const EPSILON = 1e-9;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function median(values: number[]): number | undefined {
    if (!values.length) return undefined;
    values.sort((a, b) => a - b);
    const middle = values.length >>> 1;
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

function quietFrame(position: number): MusicalFrame {
    return {
        position, beatIndex: -1, beatPhase: 0, beatCoordinate: 0, beatDuration: 0,
        barIndex: -1, barPhase: 0, barCoordinate: 0,
        beatPulse: 0, downbeatPulse: 0, active: false, strength: 0,
    };
}

/**
 * Immutable cached metadata over an already validated gameplay chart.
 * Sampling is stateless: holding its input freezes it, and seeking needs no reset.
 * Presentation guards never change the chart or generate replacement beats.
 */
export class MusicalTimeline {
    private readonly beats: readonly Beat[];
    private readonly intervals: readonly Interval[];
    private readonly quietWindows: readonly { start: number; end: number; fadeDuration: number }[];

    constructor(beats: readonly Beat[]) {
        this.beats = beats.map(beat => ({ ...beat }));
        for (let i = 0; i < this.beats.length; i++) {
            const beat = this.beats[i]!;
            if (!Number.isFinite(beat.time) || beat.time < 0 ||
                (i > 0 && beat.time <= this.beats[i - 1]!.time)) {
                throw new Error("Musical visuals require ordered finite beat timestamps.");
            }
        }
        const durations = this.beats.slice(1).map((beat, i) => beat.time - this.beats[i]!.time);
        const plausible = (duration: number) => duration >= MIN_INTERVAL - EPSILON &&
            duration <= MAX_INTERVAL + EPSILON;
        const fallback = median(durations.filter(plausible)) ?? 0.5;
        const intervals: Interval[] = this.beats.map((beat, i) => {
            // Excluding this interval prevents a large gap from validating itself.
            const neighbors: number[] = [];
            for (let j = Math.max(0, i - 4); j <= Math.min(durations.length - 1, i + 4); j++) {
                if (j !== i && plausible(durations[j]!)) neighbors.push(durations[j]!);
            }
            const normalDuration = median(neighbors) ?? fallback;
            const duration = durations[i] ?? normalDuration;
            const tooCloseBefore = i > 0 &&
                durations[i - 1]! < Math.max(MIN_INTERVAL, normalDuration * 0.35) - EPSILON;
            const usable = i < durations.length && plausible(duration) &&
                duration >= normalDuration * 0.35 - EPSILON &&
                duration <= normalDuration * 2.75 + EPSILON && !tooCloseBefore;
            return {
                duration, normalDuration, usable, quietSince: beat.time,
                barSize: 1, accentedBar: false,
            };
        });
        // One linear bar scan; no repeated bar searches while rendering.
        for (let start = 0; start < this.beats.length;) {
            let end = start + 1;
            while (end < this.beats.length && this.beats[end]!.bar === this.beats[start]!.bar) end++;
            const size = this.beats[end - 1]!.beatInBar + 1;
            for (let i = start; i < end; i++) {
                intervals[i]!.barSize = size;
                intervals[i]!.accentedBar = this.beats[start]!.downbeat;
            }
            start = end;
        }
        for (let i = 1; i < intervals.length; i++) {
            if (!intervals[i]!.usable && !intervals[i - 1]!.usable) {
                intervals[i]!.quietSince = intervals[i - 1]!.quietSince;
            }
        }
        this.intervals = intervals;
        const quietWindows: { start: number; end: number; fadeDuration: number }[] = [];
        for (let start = 0; start < intervals.length;) {
            if (intervals[start]!.usable) { start++; continue; }
            let end = start + 1;
            while (end < intervals.length && !intervals[end]!.usable) end++;
            const endTime = this.beats[end]?.time ?? Infinity;
            quietWindows.push({
                start: this.beats[start]!.time,
                end: endTime,
                fadeDuration: Math.min(0.6, intervals[start]!.normalDuration),
            });
            start = end;
        }
        this.quietWindows = quietWindows;
    }

    sample(position: number): MusicalFrame {
        const index = this.indexAt(position);
        if (index < 0) return quietFrame(Number.isFinite(position) ? position : 0);
        const beat = this.beats[index]!, interval = this.intervals[index]!;
        const elapsed = Math.max(0, position - beat.time);
        const beatDuration = interval.usable ? interval.duration : interval.normalDuration;
        // During a gap/end, finish at most the current beat, then hold. This
        // coordinate is monotonic without stretching a particle over the gap.
        const beatPhase = clamp01(elapsed / beatDuration);
        const beatCoordinate = index + beatPhase;
        const barPhase = clamp01((beat.beatInBar + beatPhase) / interval.barSize);
        const fadeDuration = Math.min(0.6, interval.normalDuration);
        const strength = interval.usable ? 1
            : this.beats.length < 2 ? 0
            : clamp01(1 - (position - interval.quietSince) / fadeDuration);
        // A malformed/terminal interval only fades the scene; it does not
        // create another rhythmic accent without a usable pair of timestamps.
        const beatPulse = interval.usable ? Math.exp(-6 * beatPhase) * (1 - beatPhase) : 0;
        const downbeatPulse = interval.accentedBar && interval.usable
            ? Math.exp(-4 * barPhase) * (1 - barPhase) : 0;
        return {
            position, beatIndex: index, beatPhase, beatCoordinate, beatDuration,
            barIndex: beat.bar, barPhase, barCoordinate: beat.bar + barPhase,
            beatPulse, downbeatPulse, active: interval.usable, strength,
        };
    }

    /**
     * Next quarter-beat (sixteenth-note) accent. It cannot precede the event on
     * either clock, and its visible wait (target - visualTime) is at most maxWait.
     * A negative calibration can therefore deliberately suppress the accent.
     * No subdivision is synthesized inside an unusable interval or beyond end.
     */
    nextSubdivision(acceptedSongTime: number, visualTime: number, maxWait = 0.1): number | undefined {
        if (![acceptedSongTime, visualTime, maxWait].every(Number.isFinite) || maxWait < 0) return;
        const earliest = Math.max(acceptedSongTime, visualTime);
        const latest = visualTime + maxWait;
        if (earliest > latest + EPSILON) return;
        let index = Math.max(0, this.indexAt(earliest));
        for (; index < this.beats.length; index++) {
            const beat = this.beats[index]!, interval = this.intervals[index]!;
            if (beat.time > latest + EPSILON) return;
            if (!interval.usable) continue;
            const subdivisionDuration = interval.duration / 4;
            const step = Math.max(0, Math.ceil((earliest - beat.time) / subdivisionDuration - EPSILON));
            // Step four belongs to the next interval: it must pass that
            // interval's guard before becoming an accent.
            if (step > 3) continue;
            const target = beat.time + step * subdivisionDuration;
            if (target >= earliest - EPSILON && target <= latest + EPSILON) return target;
        }
    }

    /** Birth/current positions use the same (normally visual) song clock. */
    ageSince(birthPosition: number, position: number): MusicalAge {
        if (!Number.isFinite(birthPosition) || !Number.isFinite(position) || position < birthPosition) {
            return { beats: 0, seconds: 0, strength: 0 };
        }
        const current = this.sample(position), birth = this.sample(birthPosition);
        // Once an effect enters a gap, its fade keeps progressing through any
        // later valid beats. Essential feedback born inside a gap starts at one
        // and fades from birth instead of inheriting the quiet arena's opacity.
        let low = 0, high = this.quietWindows.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.quietWindows[middle]!.end <= birthPosition) low = middle + 1;
            else high = middle;
        }
        const quiet = this.quietWindows[low];
        const strength = quiet
            ? clamp01(1 - Math.max(0, position - Math.max(birthPosition, quiet.start)) / quiet.fadeDuration)
            : 1;
        return {
            beats: Math.max(0, current.beatCoordinate - birth.beatCoordinate),
            seconds: position - birthPosition,
            strength,
        };
    }

    private indexAt(position: number): number {
        if (!Number.isFinite(position) || !this.beats.length || position < this.beats[0]!.time) return -1;
        let low = 0, high = this.beats.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.beats[middle]!.time <= position) low = middle + 1;
            else high = middle;
        }
        return low - 1;
    }
}

export function createMusicalTimeline(beats: readonly Beat[]): MusicalTimeline {
    return new MusicalTimeline(beats);
}
