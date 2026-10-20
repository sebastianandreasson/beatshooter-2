import { describe, expect, test } from "bun:test";
import { DEMO_TRACK } from "../tracks";
import { validateTimeline } from "../rhythm/timeline";
import { createAnalyzedChart } from "./chart";
import type { BeatAnalysis } from "./types";

function analysis(
    beats = Array.from({ length: 24 }, (_, index) => index * 0.5),
    downbeats = [0, 2, 4, 6, 8, 10],
    duration = 12,
): BeatAnalysis {
    return {
        schemaVersion: 1, analyzerVersion: "fixture-v1", duration,
        beats, downbeats, elapsedMs: 23, backend: "wasm",
    };
}

describe("detected analysis to gameplay chart", () => {
    test("known demo ground truth retains every timestamp and bar", () => {
        const chart = createAnalyzedChart(analysis(
            DEMO_TRACK.beats.map(beat => beat.time),
            DEMO_TRACK.beats.filter(beat => beat.downbeat).map(beat => beat.time),
            DEMO_TRACK.duration,
        ));
        expect(chart.beats).toEqual([...DEMO_TRACK.beats]);
        expect(chart.bpm).toBe(120);
        expect(chart.beatsPerBar).toBe(4);
        expect(chart.barSource).toBe("detected");
        expect(chart.summary).toMatchObject({
            beatCount: 144, downbeatCount: 36, barCount: 36, inferredBarCount: 0,
        });
        expect(chart.warnings).toEqual([]);
    });

    test("a 3/4 track preserves its opening pickup and nearby downbeat detections", () => {
        const times = Array.from({ length: 12 }, (_, index) => 0.25 + index * 0.5);
        const chart = createAnalyzedChart(analysis(
            times, [times[2]! + 0.03, times[5]! - 0.02, times[8]!, times[11]!], 6,
        ));
        expect(chart.beatsPerBar).toBe(3);
        expect(chart.barSource).toBe("detected");
        expect(chart.beats[0]).toEqual({
            time: 0.25, index: 0, bar: 0, beatInBar: 1, downbeat: false,
        });
        expect(chart.beats[1]!.beatInBar).toBe(2);
        expect(chart.beats[2]).toEqual({
            time: 1.25, index: 2, bar: 1, beatInBar: 0, downbeat: true,
        });
        expect(chart.beats[5]!.bar).toBe(2);
        expect(chart.beats.map(beat => beat.time)).toEqual(times);
        validateTimeline(chart.beats, 6);
    });

    test("variable-tempo timestamps are never replaced by a median-BPM grid", () => {
        const times = [0.1, 0.6, 1.11, 1.65, 2.2, 2.8, 3.45, 4.15, 4.9, 5.7, 6.55, 7.45];
        const chart = createAnalyzedChart(analysis(times, [times[0]!, times[4]!, times[8]!], 8.3));
        expect(chart.beats.map(beat => beat.time)).toEqual(times);
        expect(chart.bpm).toBeCloseTo(60 / 0.65);
        expect(chart.barSource).toBe("detected");
        expect(chart.warnings.join(" ")).toContain("spacing varies");
    });

    test("missing downbeats preserve distinct unaccented bars and later real downbeats", () => {
        const chart = createAnalyzedChart(analysis(undefined, [0, 2, 6, 8]));
        expect(chart.barSource).toBe("detected");
        expect(chart.beatsPerBar).toBe(4);
        expect(chart.beats[8]).toMatchObject({ bar: 2, beatInBar: 0, downbeat: false });
        expect(chart.beats[12]).toMatchObject({ bar: 3, beatInBar: 0, downbeat: true });
        expect(chart.beats[20]).toMatchObject({ bar: 5, beatInBar: 0, downbeat: false });
        expect(chart.summary.downbeatCount).toBe(4);
        expect(chart.summary.inferredBarCount).toBe(2);
        expect(chart.warnings.join(" ")).toContain("not accented");
        validateTimeline(chart.beats, 12);
    });

    test("mixed meter uses the detected boundaries even when the summary meter differs", () => {
        const chart = createAnalyzedChart(analysis(
            Array.from({ length: 17 }, (_, index) => index * 0.5),
            [0, 1.5, 3.5, 5, 7], 8.5,
        ));
        expect(chart.barSource).toBe("detected");
        expect(chart.beatsPerBar).toBe(4);
        expect(chart.beats[3]).toMatchObject({ bar: 1, beatInBar: 0, downbeat: true });
        expect(chart.beats[7]).toMatchObject({ bar: 2, beatInBar: 0, downbeat: true });
        expect(chart.beats[10]).toMatchObject({ bar: 3, beatInBar: 0, downbeat: true });
        expect(chart.beats[14]).toMatchObject({ bar: 4, beatInBar: 0, downbeat: true });
        validateTimeline(chart.beats, 8.5);
    });

    test("sparse, unavailable, and malformed downbeats explicitly use synthetic four-beat groups", () => {
        for (const markers of [[], [0], [0, 2], [0, NaN, 4], [4, 0, 2], [0, 0, 2]]) {
            const chart = createAnalyzedChart(analysis(undefined, markers));
            expect(chart.barSource).toBe("synthetic");
            expect(chart.beatsPerBar).toBe(4);
            expect(chart.summary.downbeatCount).toBe(0);
            expect(chart.beats[4]).toMatchObject({ bar: 1, beatInBar: 0, downbeat: true });
            expect(chart.warnings.join(" ")).toContain("synthetic groups of four");
        }
    });

    test("unmatched and ambiguous downbeats never silently snap to an arbitrary beat", () => {
        const unmatched = createAnalyzedChart(analysis(undefined, [0.25, 2.25, 4.25]));
        expect(unmatched.barSource).toBe("synthetic");
        expect(unmatched.warnings.join(" ")).toContain("3 downbeat markers were unmatched or ambiguous");
        const times = [0, 0.1, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
        const ambiguous = createAnalyzedChart(analysis(times, [0.05, 1.5, 3.5], 5));
        expect(ambiguous.barSource).toBe("synthetic");
        expect(ambiguous.warnings.join(" ")).toContain("1 downbeat marker was unmatched or ambiguous");
        const duplicateMatches = createAnalyzedChart(analysis(undefined, [0.01, 0.02, 2, 4]));
        expect(duplicateMatches.barSource).toBe("synthetic");
        expect(duplicateMatches.warnings.join(" ")).toContain("2 downbeat markers were unmatched or ambiguous");
    });

    test("timing adjustments shift timestamps and explicitly remove events outside audio", () => {
        const chart = createAnalyzedChart(analysis([-0.5, 0, 0.5, 1, 1.5, 2], [0, 1, 2], 2), 0.1);
        expect(chart.beats.map(beat => beat.time)).toEqual([0.1, 0.6, 1.1, 1.6]);
        expect(chart.firstBeatOffset).toBe(0.1);
        expect(chart.warnings.join(" ")).toContain("2 detected beats were outside");
        const earlier = createAnalyzedChart(analysis(), -0.2);
        expect(earlier.firstBeatOffset).toBe(0.3);
        expect(earlier.beats[0]!.index).toBe(0);
        validateTimeline(earlier.beats, 12);
    });

    test("silence, insufficient beats, malformed times and unsupported pulse fail clearly", () => {
        for (const times of [[], [0], [0, NaN, 1], [0, 0.5, 0.5], [1, 0], [0, Infinity], new Array<number>(4)]) {
            expect(() => createAnalyzedChart(analysis(times))).toThrow();
        }
        expect(() => createAnalyzedChart(analysis([0, 0.1, 0.2]))).toThrow("20–300 BPM");
        expect(() => createAnalyzedChart(analysis([0, 4, 8]))).toThrow("20–300 BPM");
        expect(() => createAnalyzedChart(analysis(), NaN)).toThrow("finite");
        expect(() => createAnalyzedChart(analysis(undefined, undefined, NaN))).toThrow("duration");
        expect(() => createAnalyzedChart(analysis(), 100)).toThrow("Not enough beats");
    });

    test("supported boundary tempos tolerate floating-point timestamp subtraction", () => {
        for (const bpm of [20, 300]) {
            const times = Array.from({ length: 60 }, (_, index) => 0.17 + index * 60 / bpm);
            const chart = createAnalyzedChart(analysis(times, [], times[times.length - 1]! + 1));
            expect(chart.bpm).toBeCloseTo(bpm);
        }
    });

    test("half/double-time discontinuities and long gaps get honest non-confidence warnings", () => {
        const chart = createAnalyzedChart(analysis(
            [0, 0.5, 1, 2, 3, 3.5, 4, 8, 8.5], [], 9,
        ));
        expect(chart.warnings.join(" ")).toContain("half-/double-time");
        expect(chart.warnings.join(" ")).toContain("long gap");
        expect(chart.beats.map(beat => beat.time)).toEqual([0, 0.5, 1, 2, 3, 3.5, 4, 8, 8.5]);
    });

    test("chart identity is stable across runtime details and changes with gameplay timing or authorship", () => {
        const source = analysis();
        const original = createAnalyzedChart(source);
        expect(original.chartHash).toMatch(/^chart-1-[0-9a-f]{16}$/);
        expect(createAnalyzedChart({ ...source, elapsedMs: 999, backend: "webgpu" }).chartHash)
            .toBe(original.chartHash);
        expect(createAnalyzedChart(source, -0).chartHash).toBe(original.chartHash);
        expect(createAnalyzedChart(source, 0.01).chartHash).not.toBe(original.chartHash);
        expect(createAnalyzedChart({ ...source, analyzerVersion: "fixture-v2" }).chartHash)
            .not.toBe(original.chartHash);
        expect(createAnalyzedChart({ ...source, downbeats: [] }).chartHash).not.toBe(original.chartHash);
        expect(source.beats).toEqual(analysis().beats);
    });
});
