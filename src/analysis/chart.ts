import { type Beat, validateTimeline } from "../rhythm/timeline";
import type { BeatAnalysis } from "./types";

/** Changes whenever normalization changes the resulting gameplay chart. */
export const CHART_VERSION = "1";
const DOWNBEAT_TOLERANCE_SECONDS = 0.07;
const MAX_BEATS = 108_000;

export interface AnalyzedChart {
    beats: Beat[];
    /** Median detected pulse, used for the introductory count-in and summary. */
    bpm: number;
    /** Dominant detected meter, or four for the explicitly synthetic fallback. */
    beatsPerBar: number;
    firstBeatOffset: number;
    warnings: string[];
    barSource: "detected" | "synthetic";
    chartHash: string;
    summary: {
        beatCount: number;
        /** Usable detected markers, excluding synthetic accents and inferred boundaries. */
        downbeatCount: number;
        barCount: number;
        inferredBarCount: number;
        medianBeatInterval: number;
        minBeatInterval: number;
        maxBeatInterval: number;
    };
}

function orderedTimes(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length > MAX_BEATS) return false;
    for (let index = 0; index < value.length; index++) {
        const time: unknown = value[index];
        if (typeof time !== "number" || !Number.isFinite(time) ||
            (index > 0 && time <= value[index - 1]!)) return false;
    }
    return true;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >>> 1;
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** A downbeat is accepted only when exactly one beat falls inside its window. */
function matchDownbeats(
    times: readonly number[],
    downbeats: readonly number[],
    warnings: string[],
): number[] {
    const candidates = new Map<number, number>();
    let rejected = 0;
    for (const time of downbeats) {
        let low = 0;
        let high = times.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (times[middle]! < time - DOWNBEAT_TOLERANCE_SECONDS - 1e-9) low = middle + 1;
            else high = middle;
        }
        const matches: number[] = [];
        while (low < times.length && times[low]! <= time + DOWNBEAT_TOLERANCE_SECONDS + 1e-9) {
            matches.push(low++);
            if (matches.length > 1) break;
        }
        if (matches.length !== 1) {
            rejected++;
            continue;
        }
        const index = matches[0]!;
        candidates.set(index, (candidates.get(index) ?? 0) + 1);
    }
    const unique: number[] = [];
    for (const [index, count] of candidates) {
        if (count === 1) unique.push(index);
        else rejected += count;
    }
    if (rejected) warnings.push(
        `${rejected} downbeat marker${rejected === 1 ? " was" : "s were"} unmatched or ambiguous and ignored.`,
    );
    return unique.sort((a, b) => a - b);
}

function detectMeter(downbeats: readonly number[]): number | undefined {
    if (downbeats.length < 3) return undefined;
    const intervals = downbeats.slice(1).map((index, offset) => index - downbeats[offset]!);
    const valid = intervals.filter(interval => interval >= 2 && interval <= 16);
    if (valid.length < 2 || valid.length < intervals.length * 0.5) return undefined;
    const counts = new Map<number, number>();
    for (const interval of valid) counts.set(interval, (counts.get(interval) ?? 0) + 1);
    // Four wins a tie, then the shorter candidate. The explicit boundaries remain authoritative.
    return [...counts].sort(([a, countA], [b, countB]) =>
        countB - countA || Number(b === 4) - Number(a === 4) || a - b)[0]![0];
}

function detectedBars(
    times: readonly number[],
    downbeats: readonly number[],
    meter: number,
    warnings: string[],
): { beats: Beat[]; inferredBarCount: number } {
    const detected = new Set(downbeats);
    const boundaries = new Set(downbeats);
    const first = downbeats[0]!;
    let inferredBarCount = 0;
    const infer = (index: number) => {
        if (!boundaries.has(index)) {
            boundaries.add(index);
            inferredBarCount++;
        }
    };
    // Preserve the pickup's musical phase, including leading bars with no detected accent.
    for (let index = first - meter; index >= 0; index -= meter) infer(index);
    let irregularBars = false;
    for (let index = 1; index < downbeats.length; index++) {
        const previous = downbeats[index - 1]!;
        const current = downbeats[index]!;
        const gap = current - previous;
        if (gap !== meter) irregularBars = true;
        // A long multiple can mean a missed downbeat. Preserve separate bar numbers
        // without inventing an accented downbeat at the inferred boundary.
        if ((gap > meter && gap % meter === 0) || gap > 16) {
            for (let boundary = previous + meter; boundary < current; boundary += meter) infer(boundary);
        }
    }
    for (let index = downbeats[downbeats.length - 1]! + meter; index < times.length; index += meter) infer(index);
    if (irregularBars) warnings.push(
        "Downbeat spacing varies; this may reflect changing meter or missed detections. Check the metronome preview.",
    );
    if (inferredBarCount) warnings.push(
        `${inferredBarCount} bar boundar${inferredBarCount === 1 ? "y was" : "ies were"} inferred without a detected downbeat; those boundaries are not accented.`,
    );
    let bar = 0;
    let beatInBar = (meter - first % meter) % meter;
    const beats = times.map((time, index): Beat => {
        if (index > 0) {
            if (boundaries.has(index)) { bar++; beatInBar = 0; }
            else beatInBar++;
        }
        return { time, index, bar, beatInBar, downbeat: detected.has(index) };
    });
    return { beats, inferredBarCount };
}

/** Small stable identifier, not a security hash; file identity is handled separately. */
function chartHash(value: unknown): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return `chart-${CHART_VERSION}-${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Converts analysis into a deterministic chart without fitting a constant-tempo grid.
 * Positive adjustments delay every detected event; events outside the audio are removed.
 */
export function createAnalyzedChart(analysis: BeatAnalysis, adjustmentSeconds = 0): AnalyzedChart {
    if (!analysis || analysis.schemaVersion !== 1 || typeof analysis.analyzerVersion !== "string" ||
        !analysis.analyzerVersion.trim()) {
        throw new Error("The audio analysis format or analyzer version is invalid.");
    }
    if (!Number.isFinite(analysis.duration) || analysis.duration <= 0 || analysis.duration > 21_600) {
        throw new Error("Analysis needs an audio duration between 0 and 21,600 seconds.");
    }
    if (!Number.isFinite(adjustmentSeconds)) throw new Error("Beat timing adjustment must be a finite number of seconds.");
    if (!orderedTimes(analysis.beats)) throw new Error("Detected beats must be finite, strictly increasing timestamps.");
    const warnings: string[] = [];
    const times = analysis.beats.map(time => time + adjustmentSeconds)
        .filter(time => Number.isFinite(time) && time >= 0 && time < analysis.duration);
    const removed = analysis.beats.length - times.length;
    if (removed) warnings.push(`${removed} detected beat${removed === 1 ? " was" : "s were"} outside the audio after adjustment and removed.`);
    if (times.length < 2) throw new Error("Not enough beats were detected. Try another track or enter its tempo manually.");
    const intervals = times.slice(1).map((time, index) => time - times[index]!);
    const medianInterval = median(intervals);
    const detectedBpm = 60 / medianInterval;
    if (!Number.isFinite(detectedBpm) || detectedBpm < 20 - 1e-8 || detectedBpm > 300 + 1e-8) {
        throw new Error("The detected pulse is outside 20–300 BPM. Check the track or enter its tempo manually.");
    }
    // Floating-point interval subtraction must not reject a valid boundary tempo.
    const bpm = Math.max(20, Math.min(300, detectedBpm));
    const minInterval = intervals.reduce((value, interval) => Math.min(value, interval), Infinity);
    const maxInterval = intervals.reduce((value, interval) => Math.max(value, interval), -Infinity);
    if (intervals.some(interval => Math.abs(interval / medianInterval - 1) > 0.25)) warnings.push(
        "Beat spacing varies noticeably; timestamps are preserved. Check for tempo changes or missed beats.",
    );
    if (intervals.some((interval, index) => {
        if (index === 0) return false;
        const ratio = Math.max(interval / intervals[index - 1]!, intervals[index - 1]! / interval);
        return ratio >= 1.8 && ratio <= 2.2;
    })) warnings.push(
        "Beat spacing contains near 2:1 changes. Check for tempo changes or half-/double-time detection.",
    );
    if (maxInterval > Math.max(3, medianInterval * 3)) warnings.push(
        "A long gap has no detected beats. Gameplay will keep that gap rather than invent extra shots.",
    );
    if (minInterval < 0.12) warnings.push(
        "Some detected beats are very close together. Check for extra detections before playing.",
    );
    let matched: number[] = [];
    if (orderedTimes(analysis.downbeats)) {
        const downbeats = analysis.downbeats.map(time => time + adjustmentSeconds)
            .filter(time => Number.isFinite(time) && time >= 0 && time < analysis.duration);
        if (downbeats.length !== analysis.downbeats.length) warnings.push(
            "Downbeat markers outside the adjusted audio range were removed.",
        );
        matched = matchDownbeats(times, downbeats, warnings);
    } else {
        warnings.push("Downbeat timestamps were invalid and ignored.");
    }
    const detectedMeter = detectMeter(matched);
    const barSource = detectedMeter === undefined ? "synthetic" : "detected";
    const beatsPerBar = detectedMeter ?? 4;
    let beats: Beat[];
    let inferredBarCount = 0;
    if (detectedMeter === undefined) {
        warnings.push("No usable downbeat sequence was found; waves use synthetic groups of four beats.");
        beats = times.map((time, index) => ({
            time, index, bar: Math.floor(index / 4), beatInBar: index % 4, downbeat: index % 4 === 0,
        }));
    } else {
        ({ beats, inferredBarCount } = detectedBars(times, matched, detectedMeter, warnings));
    }
    validateTimeline(beats, analysis.duration);
    return {
        beats, bpm, beatsPerBar, firstBeatOffset: times[0]!, warnings, barSource,
        chartHash: chartHash({
            chartVersion: CHART_VERSION,
            analyzerVersion: analysis.analyzerVersion,
            duration: analysis.duration,
            adjustmentSeconds: Object.is(adjustmentSeconds, -0) ? 0 : adjustmentSeconds,
            beats, bpm, beatsPerBar, barSource,
        }),
        summary: {
            beatCount: beats.length,
            downbeatCount: barSource === "detected" ? matched.length : 0,
            barCount: beats[beats.length - 1]!.bar + 1,
            inferredBarCount,
            medianBeatInterval: medianInterval,
            minBeatInterval: minInterval,
            maxBeatInterval: maxInterval,
        },
    };
}
