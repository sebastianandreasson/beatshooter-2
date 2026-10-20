import { describe, expect, test } from "bun:test";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import { createDashTiming } from "./timing";

describe("authored beat dash windows", () => {
    test("accepts both inclusive window edges and rejects offbeats and outside positions", () => {
        const timing = createDashTiming(generateTimeline(6, 120));
        for (const position of [1.85, 1.86, 1.9, 1.95, 2, 2.05, 2.1, 2.14, 2.15]) {
            expect(timing.candidate(position)).toEqual({ beatIndex: 4, bar: 1, beatInBar: 0, time: 2, beatDuration: 0.5 });
        }
        for (const position of [0.25, 0.75, 1.25, 1.84999, 2.15001, 3.25]) {
            expect(timing.candidate(position)).toBeUndefined();
        }
        expect(timing.candidate(0)?.beatIndex).toBe(0);
        expect(timing.candidate(0.15)?.beatIndex).toBe(0);
        for (const index of [1, 2, 3]) {
            expect(timing.candidate(index * .5)).toMatchObject({ beatIndex: index, bar: 0, beatInBar: index });
        }
    });

    test("count-in and nonfinite positions cannot activate even near beat zero", () => {
        const timing = createDashTiming(generateTimeline(3, 120));
        for (const position of [-0.001, -0.1, -2, NaN, Infinity, -Infinity]) {
            expect(timing.candidate(position)).toBeUndefined();
        }
        expect(createDashTiming([]).candidate(0)).toBeUndefined();
    });

    test("pickups and inferred bar starts retain their actual beat and bar identities", () => {
        const beats: Beat[] = [
            { index: 0, time: 0.2, bar: 0, beatInBar: 2, downbeat: false },
            { index: 1, time: 0.7, bar: 1, beatInBar: 0, downbeat: true },
            { index: 2, time: 1.2, bar: 1, beatInBar: 1, downbeat: false },
            { index: 3, time: 1.7, bar: 1, beatInBar: 2, downbeat: false },
            { index: 4, time: 2.2, bar: 2, beatInBar: 0, downbeat: false },
            { index: 5, time: 2.7, bar: 2, beatInBar: 1, downbeat: false },
            { index: 6, time: 3.2, bar: 3, beatInBar: 0, downbeat: true },
        ];
        const timing = createDashTiming(beats);
        expect(timing.candidate(0.2)).toMatchObject({ beatIndex: 0, bar: 0, beatInBar: 2 });
        expect(timing.candidate(0.7)).toEqual({ beatIndex: 1, bar: 1, beatInBar: 0, time: 0.7, beatDuration: 0.5 });
        expect(timing.candidate(2.2)).toMatchObject({ beatIndex: 4, bar: 2, beatInBar: 0 });
        expect(timing.candidate(3.2)?.beatIndex).toBe(6);
        expect(createDashTiming(beats.map(beat => ({ ...beat, downbeat: false }))).candidate(0.7))
            .toMatchObject({ beatIndex: 1, bar: 1 });
        expect(timing.barAt(0.1)).toBeUndefined();
        expect(timing.barAt(2.1999)).toBe(1);
        expect(timing.barAt(2.2)).toBe(2);
        expect(timing.barAt(NaN)).toBeUndefined();
    });

    test("irregular and mixed-meter charts use exact authored boundaries and outgoing local tempo", () => {
        const times = [0.13, 0.57, 1.04, 1.66, 2.26, 2.9, 3.47, 4.12, 4.85];
        const starts = [0, 3, 7];
        const beats: Beat[] = times.map((time, index) => {
            const bar = index < 3 ? 0 : index < 7 ? 1 : 2;
            return { time, index, bar, beatInBar: index - starts[bar]!, downbeat: starts.includes(index) };
        });
        const timing = createDashTiming(beats);
        expect(timing.candidate(1.6)).toMatchObject({ beatIndex: 3, time: 1.66 });
        expect(timing.candidate(1.6)!.beatDuration).toBeCloseTo(0.6);
        expect(timing.candidate(4.2)).toMatchObject({ beatIndex: 7, time: 4.12 });
        expect(timing.candidate(4.2)!.beatDuration).toBeCloseTo(0.73);
        expect(timing.candidate(2)).toBeUndefined();
    });

    test("nearest authored beat wins overlapping windows; an exact tie chooses the earlier one", () => {
        const beats: Beat[] = [1, 1.18, 1.36].map((time, index) => ({
            time, index, bar: index, beatInBar: 0, downbeat: true,
        }));
        const timing = createDashTiming(beats);
        expect(timing.candidate(1.08)?.beatIndex).toBe(0);
        expect(timing.candidate(1.09)?.beatIndex).toBe(0);
        expect(timing.candidate(1.091)?.beatIndex).toBe(1);
        expect(timing.candidate(1.18)?.beatIndex).toBe(1);
    });

    test("actual beats bordering long gaps remain eligible without inventing events inside the gap", () => {
        const beats: Beat[] = [0, 0.5, 1, 1.5, 20, 20.5, 21].map((time, index) => ({
            time, index, bar: index < 3 ? 0 : index < 4 ? 1 : 2,
            beatInBar: index < 3 ? index : index < 4 ? 0 : index - 4,
            downbeat: index === 0 || index === 3 || index === 4,
        }));
        const timing = createDashTiming(beats);
        expect(timing.candidate(1.5)).toEqual({ beatIndex: 3, bar: 1, beatInBar: 0, time: 1.5, beatDuration: 0.5 });
        expect(timing.candidate(20)).toEqual({ beatIndex: 4, bar: 2, beatInBar: 0, time: 20, beatDuration: 0.5 });
        expect(timing.candidate(10)).toBeUndefined();
    });

    test("duration uses nearby plausible intervals and a bounded neutral fallback when none is local", () => {
        const make = (times: number[], accent = 0): Beat[] => times.map((time, index) => ({
            time, index, bar: 0, beatInBar: index, downbeat: index === accent,
        }));
        expect(createDashTiming(make([0, 0.02, 0.52])).candidate(0)?.beatDuration).toBe(0.5);
        expect(createDashTiming(make([0, 10, 20])).candidate(0)?.beatDuration).toBe(0.5);
        expect(createDashTiming(make([0])).candidate(0)?.beatDuration).toBe(0.5);
        expect(createDashTiming(make([0, 0.12])).candidate(0)?.beatDuration).toBe(0.12);
        expect(createDashTiming(make([0, 3])).candidate(0)?.beatDuration).toBe(3);
        // A distant tempo on the other side of a run of missing detections is not local evidence.
        expect(createDashTiming(make([0, 10, 20, 30, 40, 50, 52])).candidate(0)?.beatDuration).toBe(0.5);
    });

    test("the final authored beat has one bounded window, with no extrapolated later beats", () => {
        const timing = createDashTiming(generateTimeline(4.1, 120));
        expect(timing.candidate(4)).toEqual({ beatIndex: 8, bar: 2, beatInBar: 0, time: 4, beatDuration: 0.5 });
        expect(timing.candidate(4.15)?.beatIndex).toBe(8);
        expect(timing.candidate(4.15001)).toBeUndefined();
        expect(timing.candidate(6)).toBeUndefined();
    });

    test("cached results neither mutate the chart nor depend on later caller mutation", () => {
        const beats = generateTimeline(6, 120);
        const original = structuredClone(beats);
        const timing = createDashTiming(beats);
        const result = timing.candidate(2)!;
        result.time = 99;
        result.beatDuration = 99;
        expect(timing.candidate(2)).toEqual({ beatIndex: 4, bar: 1, beatInBar: 0, time: 2, beatDuration: 0.5 });
        expect(beats).toEqual(original);
        beats[4] = { ...beats[4]!, time: 99, downbeat: false };
        expect(timing.candidate(2)).toEqual({ beatIndex: 4, bar: 1, beatInBar: 0, time: 2, beatDuration: 0.5 });
    });
});
