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
                index: -1, active: false, musical: false, envelope: 0,
                palette: DEFAULT_SECTION_PALETTE,
            });
        }
        const malformed = sections([0, 4, 20]);
        malformed.sections[1]!.start = 5;
        expect(new SectionTransitionTimeline(malformed, beats).sample(5).index).toBe(-1);
        const timeline = new SectionTransitionTimeline(sections([0, 4, 20], ["bridge", "verse"]), beats);
        for (const position of [-3, 0, 3.99, NaN, Infinity]) {
            expect(timeline.sample(position)).toMatchObject({
                index: 0, label: "bridge", active: false, envelope: 0,
                palette: SECTION_PALETTES.bridge,
            });
        }
    });

    test("starts at the exact detected boundary and runs the eligible four-beat wave at 1.3× speed", () => {
        const timeline = new SectionTransitionTimeline(sections([0, 2.25, 10]), generateTimeline(10, 120));
        const end = 2.25 + 2 / 1.3;
        expect(timeline.sample(2.249).active).toBe(false);
        expect(timeline.sample(2.25)).toMatchObject({
            index: 1, label: "chorus", active: true, musical: true,
            startTime: 2.25, endTime: end, progress: 0, envelope: 0,
            palette: SECTION_PALETTES.intro,
        });
        const middle = timeline.sample(2.25 + 1 / 1.3);
        expect(middle.progress).toBeCloseTo(0.5);
        expect(middle.envelope).toBeCloseTo(1);
        const ending = timeline.sample(end - 1e-6);
        expect(ending.progress).toBeCloseTo(1);
        expect(ending.envelope).toBeCloseTo(0);
        expect(timeline.sample(end)).toMatchObject({
            active: false, progress: 1, envelope: 0, palette: SECTION_PALETTES.chorus,
        });
    });

    test("musical progression follows variable intervals instead of an average BPM or elapsed seconds", () => {
        const beats = chart([0, 0.4, 1, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8]);
        const timeline = new SectionTransitionTimeline(sections([0, 0.7, 5]), beats);
        // Birth is beat 1.5; the 4 / 1.3 beat span ends at beat 4.576923.
        expect(timeline.sample(0.7).endTime).toBeCloseTo(2.588461538);
        expect(timeline.sample(1.215384615).progress).toBeCloseTo(0.25);
        expect(timeline.sample(1.819230769).progress).toBeCloseTo(0.5);
        expect(timeline.sample(2.203846154).progress).toBeCloseTo(0.75);
        expect(timeline.sample(2.59).active).toBe(false);
    });

    test("one musical beat anticipates the boundary without announcing or repainting the next section early", () => {
        const timeline = new SectionTransitionTimeline(sections([0, 2.25, 10]), generateTimeline(10, 120));
        expect(timeline.sample(1.749)).toMatchObject({ anticipating: false, anticipation: 0, impact: 0 });
        expect(timeline.sample(1.75)).toMatchObject({ anticipating: true, anticipation: 0, impact: 0 });
        const charged = timeline.sample(2);
        expect(charged).toMatchObject({
            index: 0, label: "intro", active: false, anticipating: true,
            anticipation: 0.5, impact: 0.5, palette: SECTION_PALETTES.intro,
        });
        const before = timeline.sample(2.25 - 1e-6), boundary = timeline.sample(2.25);
        expect(before.impact).toBeCloseTo(boundary.impact, 8);
        expect(boundary).toMatchObject({
            index: 1, active: true, anticipating: false, anticipation: 0, impact: 1, waveProgress: 0,
        });
        expect(timeline.sample(2.5).impact).toBeCloseTo(0.5);
        expect(timeline.sample(2.75).impact).toBe(0);
        for (let frame = 0; frame < 144; frame++) expect(timeline.sample(2)).toEqual(charged);
        timeline.sample(8);
        timeline.sample(-1);
        expect(timeline.sample(2)).toEqual(charged);
    });

    test("outward travel eases in and out while star progress retains its exact musical coordinates", () => {
        const timeline = new SectionTransitionTimeline(sections([0, 2, 10]), generateTimeline(10, 120));
        for (const [fraction, travel] of [[0.25, 0.15625], [0.5, 0.5], [0.75, 0.84375]]) {
            const frame = timeline.sample(2 + 2 / 1.3 * fraction!);
            expect(frame.progress).toBeCloseTo(fraction!);
            expect(frame.waveProgress).toBeCloseTo(travel!);
        }
        const radii = Array.from({ length: 101 }, (_, index) => timeline.sample(2 + index / (50 * 1.3)).waveProgress * 30);
        for (let index = 1; index < radii.length; index++) expect(radii[index]!).toBeGreaterThan(radii[index - 1]!);
        const firstStep = radii[1]! - radii[0]!;
        const middleStep = radii[50]! - radii[49]!;
        const lastStep = radii[100]! - radii[99]!;
        expect(middleStep).toBeGreaterThan(firstStep * 40);
        expect(lastStep).toBeCloseTo(firstStep, 8);
        expect(radii[0]).toBe(0);
        expect(radii.at(-1)).toBe(30);
    });

    test("anticipation uses irregular beat coordinates and caps a slow-song buildup", () => {
        const timeline = new SectionTransitionTimeline(sections([0, 0.7, 5]),
            chart([0, 0.4, 1, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8]));
        // The offbeat boundary is beat 1.5; charge starts at beat 0.5 (0.2 s).
        expect(timeline.sample(0.199).anticipating).toBe(false);
        expect(timeline.sample(0.2).anticipation).toBeCloseTo(0);
        expect(timeline.sample(0.4).anticipation).toBeCloseTo(0.5);
        expect(timeline.sample(0.7).impact).toBe(1);
        // Beat 2.5 falls at 1.4 s; recovery follows that real beat coordinate.
        expect(timeline.sample(1).impact).toBeCloseTo(0.5);
        expect(timeline.sample(1.4).impact).toBe(0);
        const slow = new SectionTransitionTimeline(sections([0, 3.75, 30]), generateTimeline(30, 20));
        expect(slow.sample(3.149).anticipating).toBe(false);
        expect(slow.sample(3.45).anticipation).toBeCloseTo(0.5);
        expect(slow.sample(3.75).impact).toBe(1);
    });

    test("gaps, tiny fragments and overlapping waves cannot invent or abruptly restart a charge", () => {
        const noBeats = new SectionTransitionTimeline(sections([0, 2, 10]), []);
        const tiny = new SectionTransitionTimeline(sections([0, 2, 2.1, 10]), generateTimeline(10, 120));
        const overlapping = new SectionTransitionTimeline(sections([0, 2, 2.5, 10]), generateTimeline(10, 120));
        for (const timeline of [noBeats, tiny]) {
            expect(timeline.sample(1.9)).toMatchObject({ anticipation: 0, impact: 0 });
            expect(timeline.sample(2)).toMatchObject({ anticipation: 0, impact: 0 });
        }
        expect(overlapping.sample(2.4)).toMatchObject({ anticipating: false, anticipation: 0, impact: 0 });
        expect(overlapping.sample(2.5)).toMatchObject({ active: true, musical: true, impact: 0 });
        const gap = new SectionTransitionTimeline(sections([0, 21.5, 25]),
            chart([0, 0.5, 1, 1.5, 21.5, 22, 22.5, 23, 23.5, 24]));
        expect(gap.sample(21.4)).toMatchObject({ anticipating: false, impact: 0 });
        expect(gap.sample(21.5)).toMatchObject({ active: true, musical: true, impact: 0 });
    });

    test("short sections accelerate their clipped wave and repeated labels receive a fresh color", () => {
        const timeline = new SectionTransitionTimeline(
            sections([0, 2, 3, 8], ["intro", "chorus", "chorus"]), generateTimeline(8, 120),
        );
        expect(timeline.sample(2).endTime).toBeCloseTo(2 + 1 / 1.3);
        expect(timeline.sample(2 + 0.5 / 1.3).progress).toBeCloseTo(0.5);
        expect(timeline.sample(2 + 1 / 1.3 - 1e-6).progress).toBeCloseTo(1);
        expect(timeline.sample(3)).toMatchObject({
            index: 2, label: "chorus", active: true, progress: 0,
            envelope: 0, from: SECTION_PALETTES.chorus,
        });
        expect(timeline.sample(3).to).not.toEqual(timeline.sample(3).from);
        expect(timeline.sample(3).endTime).toBeCloseTo(3 + 2 / 1.3);
        expect(timeline.sample(3 + 1 / 1.3).progress).toBeCloseTo(0.5);
    });

    test("quiet gaps fade colors only and cannot stretch or restart a wave", () => {
        const beats = chart([0, 0.5, 1, 1.5, 21.5, 22, 22.5, 23, 23.5, 24]);
        const timeline = new SectionTransitionTimeline(sections([0, 0.5, 10, 25]), beats);
        // Finish the first wave at the start of the gap, while real intervals remain.
        expect(timeline.sample(0.5).musical).toBe(true);
        expect(timeline.sample(0.5).endTime).toBeCloseTo(0.5 + 1 / 1.3);
        expect(timeline.sample(1.5)).toMatchObject({ active: false, envelope: 0 });
        expect(timeline.sample(10)).toMatchObject({
            index: 2, musical: false, active: true, endTime: 10.6, progress: 0, envelope: 0,
        });
        expect(timeline.sample(10.3).progress).toBeCloseTo(0.5);
        expect(timeline.sample(10.3).envelope).toBe(0);
        expect(timeline.sample(10.6)).toMatchObject({ active: false, palette: SECTION_PALETTES.verse });
        expect(timeline.sample(21.6)).toMatchObject({ active: false, envelope: 0, progress: 1 });
        const noBeats = new SectionTransitionTimeline(sections([0, 2, 10]), []);
        expect(noBeats.sample(2.3)).toMatchObject({ musical: false, active: true, envelope: 0 });
        expect(noBeats.sample(2.3).progress).toBeCloseTo(0.5);
    });

    test("song tails and tiny sections never produce extrapolated or abrupt waves", () => {
        const beats = generateTimeline(5, 120);
        const tail = new SectionTransitionTimeline(sections([0, 3.5, 5]), beats);
        expect(tail.sample(3.5).musical).toBe(true);
        expect(tail.sample(3.5).endTime).toBeCloseTo(3.5 + 1 / 1.3);
        expect(tail.sample(4.5)).toMatchObject({ active: false, envelope: 0 });
        const beyond = new SectionTransitionTimeline(sections([0, 4.6, 5]), beats);
        expect(beyond.sample(4.6)).toMatchObject({ musical: false, endTime: 5, active: true });
        expect(beyond.sample(5)).toMatchObject({ active: false, progress: 1 });
        const tiny = new SectionTransitionTimeline(sections([0, 2, 2.1, 5]), beats);
        expect(tiny.sample(2)).toMatchObject({ musical: false, endTime: 2.1, envelope: 0 });
        expect(tiny.sample(2.1)).toMatchObject({ index: 2, progress: 0 });
        const fragment = new SectionTransitionTimeline(sections([0, 2, 2.5, 5]), beats);
        expect(fragment.sample(2.2)).toMatchObject({ musical: false, envelope: 0 });
    });

    test("slow-track caps accelerate too and fast tracks keep their wave despite the shorter duration", () => {
        const slow = new SectionTransitionTimeline(sections([0, 3.75, 30]), generateTimeline(30, 20));
        expect(slow.sample(3.75).musical).toBe(true);
        expect(slow.sample(3.75).endTime).toBeCloseTo(3.75 + 3 / 1.3);
        expect(slow.sample(3.75 + 1.5 / 1.3).progress).toBeCloseTo(0.5);
        expect(slow.sample(3.75 + 3 / 1.3)).toMatchObject({ active: false, progress: 1, envelope: 0 });
        const medium = new SectionTransitionTimeline(sections([0, 2.5, 30]), generateTimeline(30, 60));
        expect(medium.sample(2.5).musical).toBe(true);
        expect(medium.sample(2.5).endTime).toBeCloseTo(2.5 + 2 / 1.3);
        const fast = new SectionTransitionTimeline(sections([0, 2, 30]), generateTimeline(30, 300));
        expect(fast.sample(2)).toMatchObject({ musical: true });
        expect(fast.sample(2).endTime).toBeCloseTo(2 + 0.8 / 1.3);
        expect(fast.sample(2 + 0.4 / 1.3).progress).toBeCloseTo(0.5);
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

    test("every adjacent section gets a visibly different deterministic palette, including repeated labels and quiet fades", () => {
        const sequences: SectionLabel[][] = [
            ...SECTION_LABELS.map(label => Array<SectionLabel>(5).fill(label)),
            ["verse", "inst", "chorus", "chorus", "inst", "intro", "bridge", "bridge", "silence"],
        ];
        for (const labels of sequences) {
            const structure = sections(Array.from({ length: labels.length + 1 }, (_, i) => i * 3), labels);
            const beats = generateTimeline(structure.duration, 120);
            const timeline = new SectionTransitionTimeline(structure, beats);
            const replay = new SectionTransitionTimeline(structure, beats);
            const quiet = new SectionTransitionTimeline(structure, []);
            for (let i = 1; i < labels.length; i++) {
                const frame = timeline.sample(i * 3);
                expect(frame.label).toBe(labels[i]);
                expect(frame.from).toEqual(timeline.sample((i - 1) * 3).to);
                expect(frame.to).not.toEqual(frame.from);
                expect(Math.max(...frame.to.accent.map((channel, n) => Math.abs(channel - frame.from.accent[n]!))))
                    .toBeGreaterThan(0.1);
                expect(timeline.sample(frame.endTime + 0.01).palette).toEqual(frame.to);
                expect(quiet.sample(i * 3).to).toEqual(frame.to);
                expect(quiet.sample(i * 3 + 0.6).palette).toEqual(frame.to);
                timeline.sample(structure.duration);
                expect(timeline.sample(i * 3)).toEqual(replay.sample(i * 3));
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
        expect(timeline.sample(2.4).progress).toBeCloseTo(0.26);
        expect(timeline.sample(2.6).progress).toBeCloseTo(0.39);
        structure.sections[1]!.start = 3;
        structure.sections[1]!.label = "bridge";
        beats[5] = { ...beats[5]!, time: 7 };
        expect(timeline.sample(2.73)).toEqual(expected);
        expect(new SectionTransitionTimeline(sections([0, 2, 8]), generateTimeline(8, 120)).sample(2.73)).toEqual(expected);
    });
});
