import { describe, expect, test } from "bun:test";
import type { SectionAnalysis, SectionLabel } from "../analysis/sections";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import { SectionTransitionTimeline } from "../section-effects/state";
import { STAR_BASE_SPEED, STAR_HYPERSPACE_MULTIPLIER, StarfieldTimeline } from "./motion";

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

describe("absolute music-time starfield travel", () => {
    test("missing, malformed or single-section analysis keeps constant baseline speed", () => {
        const beats = generateTimeline(12, 120);
        const invalid = sections([0, 2, 12]);
        invalid.sections[1]!.start = 3;
        for (const structure of [undefined, invalid, sections([0, 12])]) {
            const timeline = new StarfieldTimeline(structure, beats);
            for (const time of [0, 0.25, 2, 4, 12, 50]) {
                expect(timeline.sample(time)).toEqual({ distance: time * 5, speed: 5, boost: 0 });
            }
            for (const time of [-3, NaN, Infinity, -Infinity]) {
                expect(timeline.sample(time)).toEqual({ distance: 0, speed: 5, boost: 0 });
            }
        }
    });

    test("an exact off-beat boundary smoothly boosts speed and preserves all completed travel", () => {
        const timeline = new StarfieldTimeline(sections([0, 2.25, 10]), generateTimeline(10, 120));
        const start = 2.25, duration = 2 / 1.3, midpoint = start + duration / 2;
        expect(timeline.sample(2.25)).toEqual({ distance: 11.25, speed: 5, boost: 0 });
        expect(timeline.sample(start + duration / 4).speed).toBeCloseTo(65);
        expect(timeline.sample(midpoint).distance).toBeCloseTo(5 * midpoint + 30 * duration, 10);
        expect(timeline.sample(midpoint).boost).toBeCloseTo(1, 12);
        expect(timeline.sample(midpoint).speed / timeline.sample(start).speed).toBe(25);
        expect(STAR_BASE_SPEED).toBe(5);
        expect(STAR_HYPERSPACE_MULTIPLIER).toBe(25);
        expect(timeline.sample(start + duration * 0.75).speed).toBeCloseTo(65);
        // Mean extra speed remains 60; the 30% faster wave shortens its integral.
        for (const time of [start + duration, 7, 12]) {
            expect(timeline.sample(time).distance).toBeCloseTo(5 * time + 60 * duration, 10);
            expect(timeline.sample(time).speed).toBe(5);
            expect(timeline.sample(time).boost).toBe(0);
        }
    });

    test("variable-tempo speed follows the section envelope and distance matches its integral", () => {
        const beats = chart([0, 0.4, 1, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8]);
        const structure = sections([0, 0.7, 5]);
        const wave = new SectionTransitionTimeline(structure, beats);
        const timeline = new StarfieldTimeline(structure, beats);
        const start = 0.7, end = wave.sample(start).endTime;
        // Start coordinate is 1.5. The shortened span ends between beats 4 and 5.
        expect(end).toBeCloseTo(2.3 + 0.5 * (1.5 + 4 / 1.3 - 4), 12);
        for (const position of [start, 0.9, 1, 1.4, 1.8, 2.05, 2.3, 2.55, 2.8]) {
            const expectedBoost = wave.sample(position).envelope;
            expect(timeline.sample(position).boost).toBeCloseTo(expectedBoost, 12);
            expect(timeline.sample(position).speed).toBeCloseTo(5 + 120 * expectedBoost, 11);
            const step = 1e-6;
            const derivative = (timeline.sample(position + step).distance -
                timeline.sample(position - step).distance) / (step * 2);
            expect(derivative).toBeCloseTo(timeline.sample(position).speed, 4);
        }
        // Independent midpoint quadrature checks the analytic piecewise integral.
        const steps = 10_000, dt = (end - start) / steps;
        let reference = end * 5;
        for (let index = 0; index < steps; index++) {
            reference += 120 * wave.sample(start + (index + 0.5) * dt).envelope * dt;
        }
        expect(timeline.sample(end).distance).toBeCloseTo(reference, 6);
        expect(timeline.sample(end).speed).toBe(5);
    });

    test("adjacent repeated-label windows add travel without jumping at shared boundaries", () => {
        const structure = sections([0, 2, 3, 8], ["intro", "chorus", "chorus"]);
        const timeline = new StarfieldTimeline(structure, generateTimeline(8, 120));
        // Clipping happens before both windows are shortened by the wave speed.
        const firstDuration = 1 / 1.3, secondDuration = 2 / 1.3;
        const secondMidpoint = 3 + secondDuration / 2;
        expect(timeline.sample(3).distance).toBeCloseTo(15 + 60 * firstDuration, 10);
        expect(timeline.sample(3).speed).toBe(5);
        expect(timeline.sample(secondMidpoint).distance)
            .toBeCloseTo(5 * secondMidpoint + 60 * firstDuration + 30 * secondDuration, 10);
        expect(timeline.sample(secondMidpoint).speed).toBe(125);
        expect(timeline.sample(5).distance).toBeCloseTo(25 + 60 * (firstDuration + secondDuration), 10);
        expect(timeline.sample(5).speed).toBe(5);
        for (const boundary of [2, 2.5, 2 + firstDuration, 3, 3.5, secondMidpoint, 4, 4.5, 3 + secondDuration]) {
            const before = timeline.sample(boundary - 1e-7);
            const after = timeline.sample(boundary + 1e-7);
            expect(after.distance).toBeGreaterThan(before.distance);
            expect(after.distance - before.distance).toBeLessThan(0.00003);
            expect(after.speed).toBeCloseTo(before.speed, 3);
        }
    });

    test("quiet gaps, missing beats, tiny spans and the song tail never invent a boost", () => {
        const beats = chart([0, 0.5, 1, 1.5, 21.5, 22, 22.5, 23, 23.5, 24]);
        const gap = new StarfieldTimeline(sections([0, 0.5, 10, 25]), beats);
        // The eligible window is clipped before the gap then shortened; the quiet fade adds no travel.
        for (const time of [1.5, 10.3, 21.6]) {
            expect(gap.sample(time).distance).toBeCloseTo(5 * time + 60 / 1.3, 10);
            expect(gap.sample(time).speed).toBe(5);
            expect(gap.sample(time).boost).toBe(0);
        }
        for (const missing of [[], chart([0])]) {
            expect(new StarfieldTimeline(sections([0, 2, 10]), missing).sample(2.3))
                .toEqual({ distance: 11.5, speed: 5, boost: 0 });
        }
        const tiny = new StarfieldTimeline(sections([0, 2, 2.5, 5]), generateTimeline(5, 120));
        expect(tiny.sample(2.4)).toEqual({ distance: 12, speed: 5, boost: 0 });
        const tail = new StarfieldTimeline(sections([0, 4.6, 5]), generateTimeline(5, 120));
        expect(tail.sample(4.9)).toEqual({ distance: 24.5, speed: 5, boost: 0 });
    });

    test("slow and fast tracks integrate the existing bounded musical windows", () => {
        const slow = new StarfieldTimeline(sections([0, 3.75, 30]), generateTimeline(30, 20));
        expect(slow.sample(3.75 + 3 / 1.3 / 2).speed).toBe(125);
        expect(slow.sample(6.75).distance).toBeCloseTo(33.75 + 180 / 1.3, 10);
        expect(slow.sample(6.75).speed).toBe(5);
        expect(slow.sample(6.75).boost).toBe(0);
        const fast = new StarfieldTimeline(sections([0, 2, 30]), generateTimeline(30, 300));
        // The original 0.8s window is eligible before speeding up, even though
        // the shorter window now falls below the initial 0.65s cutoff.
        expect(fast.sample(2 + 0.8 / 1.3 / 2).speed).toBeCloseTo(125);
        expect(fast.sample(3).distance).toBeCloseTo(15 + 48 / 1.3);
        expect(fast.sample(3).boost).toBe(0);
    });

    test("pause, slowdown, seek, retry and frame rate never change an absolute sample", () => {
        const structure = sections([0, 2, 5, 10]);
        const beats = generateTimeline(10, 120);
        const timeline = new StarfieldTimeline(structure, beats);
        const expected = timeline.sample(5.73);
        for (const fps of [30, 60, 144]) {
            for (let frame = 0; frame / fps < 5.73; frame++) timeline.sample(frame / fps);
            expect(timeline.sample(5.73)).toEqual(expected);
        }
        for (let frame = 0; frame < 50; frame++) expect(timeline.sample(5.73)).toEqual(expected);
        timeline.sample(100);
        timeline.sample(0);
        expect(timeline.sample(5.73)).toEqual(expected);
        // Halving music-time advance halves the interval being traversed, without a second clock.
        expect(timeline.sample(1.4).distance - timeline.sample(1.2).distance).toBeCloseTo(1);
        structure.sections[1]!.start = 3;
        structure.sections[1]!.label = "bridge";
        beats[5] = { ...beats[5]!, time: 7 };
        expect(timeline.sample(5.73)).toEqual(expected);
        expect(new StarfieldTimeline(sections([0, 2, 5, 10]), generateTimeline(10, 120)).sample(5.73))
            .toEqual(expected);
    });

    test("travel remains monotonic and bounded by the baseline and peak speeds", () => {
        const timeline = new StarfieldTimeline(
            sections([0, 1.75, 3, 5.25, 10]), generateTimeline(10, 137),
        );
        let previous = timeline.sample(0);
        const dt = 0.031;
        for (let position = dt; position < 15; position += dt) {
            const current = timeline.sample(position);
            expect(current.speed).toBeGreaterThanOrEqual(5);
            expect(current.speed).toBeLessThanOrEqual(125);
            expect(current.boost).toBeGreaterThanOrEqual(0);
            expect(current.boost).toBeLessThanOrEqual(1);
            expect(current.distance - previous.distance).toBeGreaterThanOrEqual(5 * dt - 1e-10);
            expect(current.distance - previous.distance).toBeLessThanOrEqual(125 * dt + 1e-10);
            previous = current;
        }
    });
});
