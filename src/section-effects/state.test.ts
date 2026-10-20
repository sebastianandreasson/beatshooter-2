import { describe, expect, test } from "bun:test";
import { SECTION_LABELS, type SectionAnalysis, type SectionLabel } from "../analysis/sections";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import { DEFAULT_SECTION_PALETTE, SECTION_PALETTES, SectionTransitionTimeline } from "./state";

function sections(boundaries: number[], labels: SectionLabel[] = ["intro", "chorus", "verse"]): SectionAnalysis {
    return {
        version: 1, analyzerVersion: "test", duration: boundaries.at(-1)!,
        elapsedMs: 0, backend: "wasm",
        sections: boundaries.slice(0, -1).map((start, index) => ({
            start, end: boundaries[index + 1]!, label: labels[index % labels.length]!,
        })),
    };
}

function chart(times: number[]): Beat[] {
    return times.map((time, index) => ({
        time, index, bar: Math.floor(index / 4), beatInBar: index % 4, downbeat: index % 4 === 0,
    }));
}

describe("section transition sampling", () => {
    test("missing or malformed analysis preserves the old arena, and count-in has no entrance effect", () => {
        const beats = generateTimeline(20, 120);
        const empty = new SectionTransitionTimeline(undefined, beats);
        for (const position of [-1, 0, 4, 100, NaN, Infinity]) {
            expect(empty.sample(position)).toMatchObject({
                index: -1, active: false, musical: false, roll: 0, travel: 0,
                palette: DEFAULT_SECTION_PALETTE,
            });
        }
        const malformed = sections([0, 4, 20]);
        malformed.sections[1]!.start = 5;
        expect(new SectionTransitionTimeline(malformed, beats).sample(5).index).toBe(-1);
        const timeline = new SectionTransitionTimeline(sections([0, 4, 20], ["bridge", "verse"]), beats);
        for (const position of [-3, 0, 3.99, NaN, Infinity]) {
            expect(timeline.sample(position)).toMatchObject({
                index: 0, label: "bridge", active: false, roll: 0,
                palette: SECTION_PALETTES.bridge,
            });
        }
    });

    test("starts at the exact detected boundary and completes a full turn over four actual beats", () => {
        const timeline = new SectionTransitionTimeline(sections([0, 2.25, 10]), generateTimeline(10, 120));
        expect(timeline.sample(2.249).active).toBe(false);
        expect(timeline.sample(2.25)).toMatchObject({
            index: 1, label: "chorus", active: true, musical: true,
            startTime: 2.25, endTime: 4.25, progress: 0, roll: 0, envelope: 0,
            palette: SECTION_PALETTES.intro,
        });
        const middle = timeline.sample(3.25);
        expect(middle.progress).toBeCloseTo(0.5);
        expect(middle.roll).toBeCloseTo(Math.PI);
        expect(middle.envelope).toBeCloseTo(1);
        const ending = timeline.sample(4.25 - 1e-6);
        expect(ending.roll).toBeCloseTo(Math.PI * 2);
        expect(ending.travel).toBeCloseTo(0);
        expect(timeline.sample(4.25)).toMatchObject({
            active: false, progress: 1, roll: 0, travel: 0, palette: SECTION_PALETTES.chorus,
        });
    });

    test("musical progression follows variable intervals instead of an average BPM or elapsed seconds", () => {
        const beats = chart([0, 0.4, 1, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8]);
        const timeline = new SectionTransitionTimeline(sections([0, 0.7, 5]), beats);
        // Birth is beat 1.5; the turn ends at beat 5.5, or 3.05 seconds.
        expect(timeline.sample(0.7).endTime).toBeCloseTo(3.05);
        expect(timeline.sample(1.4).progress).toBeCloseTo(0.25);
        expect(timeline.sample(2.05).progress).toBeCloseTo(0.5);
        expect(timeline.sample(2.55).progress).toBeCloseTo(0.75);
        expect(timeline.sample(3.05).active).toBe(false);
    });

    test("short sections finish upright at the next boundary, including repeated equal labels", () => {
        const timeline = new SectionTransitionTimeline(
            sections([0, 2, 3, 8], ["intro", "chorus", "chorus"]), generateTimeline(8, 120),
        );
        expect(timeline.sample(2).endTime).toBe(3);
        expect(timeline.sample(2.5).roll).toBeCloseTo(Math.PI);
        expect(timeline.sample(3 - 1e-6).roll).toBeCloseTo(Math.PI * 2);
        expect(timeline.sample(3)).toMatchObject({
            index: 2, label: "chorus", active: true, progress: 0,
            roll: 0, endTime: 5, from: SECTION_PALETTES.chorus, to: SECTION_PALETTES.chorus,
        });
        expect(timeline.sample(4).roll).toBeCloseTo(Math.PI);
    });

    test("quiet gaps fade colors only and cannot stretch or restart a cinematic turn", () => {
        const beats = chart([0, 0.5, 1, 1.5, 21.5, 22, 22.5, 23, 23.5, 24]);
        const timeline = new SectionTransitionTimeline(sections([0, 0.5, 10, 25]), beats);
        // Finish the first turn at the start of the gap, while real intervals remain.
        expect(timeline.sample(0.5)).toMatchObject({ musical: true, endTime: 1.5 });
        expect(timeline.sample(1.5)).toMatchObject({ active: false, roll: 0 });
        expect(timeline.sample(10)).toMatchObject({
            index: 2, musical: false, active: true, endTime: 10.6, progress: 0, roll: 0,
        });
        expect(timeline.sample(10.3).progress).toBeCloseTo(0.5);
        expect(timeline.sample(10.3)).toMatchObject({ envelope: 0, travel: 0 });
        expect(timeline.sample(10.6)).toMatchObject({ active: false, palette: SECTION_PALETTES.verse });
        expect(timeline.sample(21.6)).toMatchObject({ active: false, roll: 0, progress: 1 });
        const noBeats = new SectionTransitionTimeline(sections([0, 2, 10]), []);
        expect(noBeats.sample(2.3)).toMatchObject({ musical: false, active: true, roll: 0 });
        expect(noBeats.sample(2.3).progress).toBeCloseTo(0.5);
    });

    test("song tails and tiny sections never produce extrapolated or abrupt turns", () => {
        const beats = generateTimeline(5, 120);
        const tail = new SectionTransitionTimeline(sections([0, 3.5, 5]), beats);
        expect(tail.sample(3.5)).toMatchObject({ musical: true, endTime: 4.5 });
        expect(tail.sample(4.5)).toMatchObject({ active: false, roll: 0 });
        const beyond = new SectionTransitionTimeline(sections([0, 4.6, 5]), beats);
        expect(beyond.sample(4.6)).toMatchObject({ musical: false, endTime: 5, active: true });
        expect(beyond.sample(5)).toMatchObject({ active: false, progress: 1 });
        const tiny = new SectionTransitionTimeline(sections([0, 2, 2.1, 5]), beats);
        expect(tiny.sample(2)).toMatchObject({ musical: false, endTime: 2.1, roll: 0 });
        expect(tiny.sample(2.1)).toMatchObject({ index: 2, progress: 0 });
        const fragment = new SectionTransitionTimeline(sections([0, 2, 2.5, 5]), beats);
        expect(fragment.sample(2.2)).toMatchObject({ musical: false, roll: 0 });
    });

    test("slow tracks halve the beat count to bound the turn while fast tracks keep a full bar", () => {
        const slow = new SectionTransitionTimeline(sections([0, 3.75, 30]), generateTimeline(30, 20));
        expect(slow.sample(3.75)).toMatchObject({ musical: true, endTime: 6.75 });
        expect(slow.sample(5.25).progress).toBeCloseTo(0.5);
        expect(slow.sample(6.75).roll).toBe(0);
        const medium = new SectionTransitionTimeline(sections([0, 2.5, 30]), generateTimeline(30, 60));
        expect(medium.sample(2.5)).toMatchObject({ musical: true, endTime: 4.5 });
        const fast = new SectionTransitionTimeline(sections([0, 2, 30]), generateTimeline(30, 300));
        expect(fast.sample(2)).toMatchObject({ musical: true });
        expect(fast.sample(2).endTime).toBeCloseTo(2.8);
        expect(fast.sample(2.4).progress).toBeCloseTo(0.5);
    });

    test("all label palettes stay dark and interpolation is continuous without flashes", () => {
        expect(Object.keys(SECTION_PALETTES).sort()).toEqual([...SECTION_LABELS].sort());
        const timeline = new SectionTransitionTimeline(
            sections([0, 4, 8, 12, 16, 20, 24, 28], [...SECTION_LABELS]), generateTimeline(28, 120),
        );
        for (const palette of Object.values(SECTION_PALETTES)) {
            expect(Math.max(...palette.floor)).toBeLessThanOrEqual(0.035);
            expect(Math.max(...palette.line)).toBeLessThanOrEqual(0.11);
            expect(Math.max(...palette.accent)).toBeLessThanOrEqual(0.36);
        }
        for (let time = 0; time < 28; time += 0.127) {
            const frame = timeline.sample(time);
            const next = timeline.sample(time + 0.001);
            for (const key of ["floor", "line", "accent", "clearColor"] as const) {
                for (let channel = 0; channel < 3; channel++) {
                    const value = frame.palette[key][channel]!;
                    expect(value).toBeGreaterThanOrEqual(Math.min(frame.from[key][channel]!, frame.to[key][channel]!));
                    expect(value).toBeLessThanOrEqual(Math.max(frame.from[key][channel]!, frame.to[key][channel]!));
                    expect(Math.abs(value - next.palette[key][channel]!)).toBeLessThan(0.001);
                }
            }
        }
    });

    test("pause, slowdown, frame rate, seek and retry all sample the same owned timeline", () => {
        const structure = sections([0, 2, 8]);
        const beats = generateTimeline(8, 120);
        const timeline = new SectionTransitionTimeline(structure, beats);
        const expected = timeline.sample(2.73);
        for (const fps of [30, 60, 144]) {
            for (let frame = 0; frame / fps < 2.73; frame++) timeline.sample(frame / fps);
            expect(timeline.sample(2.73)).toEqual(expected);
        }
        for (let frame = 0; frame < 144; frame++) expect(timeline.sample(2.73)).toEqual(expected);
        timeline.sample(100);
        timeline.sample(-1);
        expect(timeline.sample(2.73)).toEqual(expected);
        expect(timeline.sample(2.4).progress).toBeCloseTo(0.2);
        expect(timeline.sample(2.6).progress).toBeCloseTo(0.3);
        structure.sections[1]!.start = 3;
        structure.sections[1]!.label = "bridge";
        beats[5] = { ...beats[5]!, time: 7 };
        expect(timeline.sample(2.73)).toEqual(expected);
        expect(new SectionTransitionTimeline(sections([0, 2, 8]), generateTimeline(8, 120)).sample(2.73)).toEqual(expected);
    });
});
