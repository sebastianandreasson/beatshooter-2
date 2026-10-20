import { describe, expect, test } from "bun:test";
import { generateTimeline, type Beat } from "./timeline";
import { createMusicalTimeline } from "./visual";

function chart(times: number[], bars?: number[], accents?: number[]): Beat[] {
    let start = 0;
    return times.map((time, index) => {
        const bar = bars?.[index] ?? Math.floor(index / 4);
        if (index && bar !== (bars?.[index - 1] ?? Math.floor((index - 1) / 4))) start = index;
        return { time, index, bar, beatInBar: index - start, downbeat: accents ? accents.includes(index) : index === start };
    });
}

describe("musical presentation sampling", () => {
    test("uses exact changing intervals and actual mixed-meter bars", () => {
        const beats = chart(
            [0, 0.4, 1, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3],
            [0, 0, 0, 1, 1, 1, 1, 2, 2],
        );
        const timeline = createMusicalTimeline(beats);
        expect(timeline.sample(0.7)).toMatchObject({
            beatIndex: 1, beatDuration: 0.6, barIndex: 0, active: true,
        });
        expect(timeline.sample(0.7).beatPhase).toBeCloseTo(0.5);
        expect(timeline.sample(0.7).barPhase).toBeCloseTo(0.5);
        expect(timeline.sample(2.55).barPhase).toBeCloseTo(0.375);
        expect(timeline.sample(1.8).downbeatPulse).toBe(1);
    });

    test("pickup numbering and inferred boundaries do not invent accents", () => {
        const beats: Beat[] = [
            { time: 0.2, index: 0, bar: 0, beatInBar: 2, downbeat: false },
            { time: 0.7, index: 1, bar: 1, beatInBar: 0, downbeat: true },
            { time: 1.2, index: 2, bar: 1, beatInBar: 1, downbeat: false },
            { time: 1.7, index: 3, bar: 1, beatInBar: 2, downbeat: false },
            { time: 2.2, index: 4, bar: 2, beatInBar: 0, downbeat: false },
            { time: 2.7, index: 5, bar: 2, beatInBar: 1, downbeat: false },
            { time: 3.2, index: 6, bar: 3, beatInBar: 0, downbeat: true },
        ];
        const timeline = createMusicalTimeline(beats);
        expect(timeline.sample(0.2).barPhase).toBeCloseTo(2 / 3);
        expect(timeline.sample(0.2).downbeatPulse).toBe(0);
        expect(timeline.sample(0.7).downbeatPulse).toBe(1);
        expect(timeline.sample(2.2).beatPulse).toBe(1);
        expect(timeline.sample(2.2).downbeatPulse).toBe(0);
        expect(timeline.sample(2.2).barCoordinate).toBe(2);
    });

    test("a detection gap finishes a beat then holds, fades, and does not fabricate pulses", () => {
        const timeline = createMusicalTimeline(chart([0, 0.5, 1, 1.5, 21.5, 22, 22.5]));
        expect(timeline.sample(1.5)).toMatchObject({ active: false, strength: 1, beatPulse: 0, downbeatPulse: 0 });
        expect(timeline.sample(1.75).strength).toBeCloseTo(0.5);
        expect(timeline.sample(2.1).strength).toBe(0);
        expect(timeline.sample(2.1).beatCoordinate).toBe(4);
        expect(timeline.sample(20).beatCoordinate).toBe(4);
        expect(timeline.nextSubdivision(10, 10)).toBeUndefined();
        expect(timeline.sample(21.5)).toMatchObject({ active: true, strength: 1, beatIndex: 4 });
        const age = timeline.ageSince(1.4, 20);
        expect(age.beats).toBeCloseTo(1.2);
        expect(age.strength).toBe(0);
        expect(timeline.ageSince(1.4, 21.6).strength).toBe(0);
        expect(timeline.ageSince(21.5, 21.6).strength).toBe(1);
        expect(timeline.ageSince(10, 10).strength).toBe(1);
        expect(timeline.ageSince(10, 10.25).strength).toBeCloseTo(0.5);
        expect(timeline.ageSince(10, 10.6).strength).toBe(0);
        let previous = -Infinity;
        for (let time = 0; time < 23; time += 0.013) {
            const coordinate = timeline.sample(time).beatCoordinate;
            expect(coordinate).toBeGreaterThanOrEqual(previous);
            previous = coordinate;
        }
    });

    test("isolated close detections suppress their intervals while legitimate fast and slow tempos work", () => {
        const timeline = createMusicalTimeline(chart([0, 0.5, 0.52, 1, 1.5, 2]));
        expect(timeline.sample(0.51).active).toBe(false);
        expect(timeline.sample(0.52).beatPulse).toBe(0);
        expect(timeline.nextSubdivision(0.53, 0.53)).toBeUndefined();
        expect(timeline.sample(1).active).toBe(true);
        for (const bpm of [20, 300]) {
            const normal = createMusicalTimeline(generateTimeline(20, bpm));
            expect(normal.sample(0).active).toBe(true);
            expect(normal.sample(60 / bpm / 2).beatPhase).toBeCloseTo(0.5);
        }
    });

    test("empty, count-in, single-beat and final-tail samples settle without extrapolating rhythm", () => {
        expect(createMusicalTimeline([]).sample(2)).toMatchObject({ active: false, strength: 0, beatIndex: -1 });
        expect(createMusicalTimeline(chart([1])).sample(1)).toMatchObject({ active: false, strength: 0 });
        const timeline = createMusicalTimeline(chart([0.3, 0.8, 1.3]));
        expect(timeline.sample(-1)).toMatchObject({ active: false, strength: 0, beatIndex: -1 });
        expect(timeline.nextSubdivision(-0.1, -0.1)).toBeUndefined();
        expect(timeline.sample(1.3)).toMatchObject({ active: false, beatPulse: 0 });
        expect(timeline.sample(2)).toMatchObject({ active: false, strength: 0, beatCoordinate: 3 });
        expect(timeline.nextSubdivision(1.3, 1.3)).toBeUndefined();
        expect(timeline.sample(NaN).position).toBe(0);
        expect(timeline.ageSince(2, 1)).toEqual({ beats: 0, seconds: 0, strength: 0 });
    });

    test("subdivision accents obey both clocks and the visible wait cap at +/-250 ms", () => {
        const timeline = createMusicalTimeline(generateTimeline(8, 120));
        expect(timeline.nextSubdivision(0.17, 0.17)).toBeCloseTo(0.25);
        expect(timeline.nextSubdivision(0.13, 0.13)).toBeUndefined();
        expect(timeline.nextSubdivision(0.25, 0.25)).toBeCloseTo(0.25);
        expect(timeline.nextSubdivision(0.17, 0.42)).toBeCloseTo(0.5);
        expect(timeline.nextSubdivision(0.42, 0.17)).toBeUndefined();
        for (const offset of [-0.25, -0.05, 0, 0.05, 0.25]) {
            for (let time = 0; time < 7; time += 0.017) {
                const visual = time + offset;
                const target = timeline.nextSubdivision(time, visual);
                if (target === undefined) continue;
                expect(target).toBeGreaterThanOrEqual(Math.max(time, visual) - 1e-9);
                expect(target - visual).toBeLessThanOrEqual(0.1 + 1e-9);
                expect(target / 0.125).toBeCloseTo(Math.round(target / 0.125));
                expect(timeline.sample(target).active).toBe(true);
            }
        }
        expect(timeline.nextSubdivision(NaN, 0)).toBeUndefined();
        expect(timeline.nextSubdivision(0, 0, -1)).toBeUndefined();
    });

    test("subdivisions use local variable tempo and reject a boundary leading into a gap", () => {
        const timeline = createMusicalTimeline(chart([0, 0.4, 1, 1.8, 2.3, 20, 20.5, 21]));
        expect(timeline.nextSubdivision(0.48, 0.48)).toBeCloseTo(0.55);
        expect(timeline.nextSubdivision(1.32, 1.32)).toBeCloseTo(1.4);
        expect(timeline.nextSubdivision(2.25, 2.25)).toBeUndefined();
    });

    test("render frequency, pause and backward sampling do not change phases or effect age", () => {
        const timeline = createMusicalTimeline(chart([0, 0.5, 1.1, 1.8, 2.6, 3.2, 3.7, 4.2]));
        const expected = timeline.sample(2.37);
        const expectedAge = timeline.ageSince(0.7, 2.37);
        for (const fps of [30, 60, 144]) {
            for (let frame = 0; frame / fps < 2.37; frame++) timeline.sample(frame / fps);
            expect(timeline.sample(2.37)).toEqual(expected);
            expect(timeline.ageSince(0.7, 2.37)).toEqual(expectedAge);
        }
        for (let frame = 0; frame < 144; frame++) expect(timeline.sample(2.37)).toEqual(expected);
        timeline.sample(100);
        timeline.sample(0.1);
        expect(timeline.sample(2.37)).toEqual(expected);
    });

    test("construction owns its cached chart and rejects invalid time order", () => {
        const beats = generateTimeline(4, 120);
        const timeline = createMusicalTimeline(beats);
        const expected = timeline.sample(0.25);
        beats[0] = { ...beats[0]!, time: 3 };
        expect(timeline.sample(0.25)).toEqual(expected);
        for (const times of [[0, 0], [1, 0], [NaN, 1], [-1, 0]]) {
            expect(() => createMusicalTimeline(chart(times))).toThrow("ordered finite");
        }
    });
});
