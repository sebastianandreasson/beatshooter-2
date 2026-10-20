import { expect, test } from "bun:test";
import { generateTimeline } from "../rhythm/timeline";
import { levelUpPauseTarget } from "./upgrade-timing";

test("upgrade stops use actual beat subdivisions across tempo changes", () => {
    const times = [0, 0.5, 1.3, 1.9, 2.6, 3.1];
    const beats = generateTimeline(4, 120).slice(0, times.length)
        .map((beat, index) => ({ ...beat, time: times[index]! }));
    expect(levelUpPauseTarget(beats, 0.1, 4)).toBeCloseTo(0.21875);
    expect(levelUpPauseTarget(beats, 0.6, 4)).toBeCloseTo(0.7);
    expect(levelUpPauseTarget(beats, 1.4, 4)).toBeCloseTo(1.525);
});

test("slow, fast, missing, and final beats keep the pause transition bounded", () => {
    for (const bpm of [20, 120, 300]) {
        const beats = generateTimeline(20, bpm);
        const interval = 60 / bpm;
        const spacing = interval / 2 ** Math.ceil(Math.log2(interval / 0.04));
        for (const position of [0, 0.03, 0.135, interval - 0.02, interval + 0.037]) {
            const target = levelUpPauseTarget(beats, position, 20);
            expect(target - position).toBeGreaterThanOrEqual(0.1 - 1e-8);
            expect(target - position).toBeLessThanOrEqual(0.14 + 1e-8);
            expect(target / spacing).toBeCloseTo(Math.round(target / spacing));
            // The transport integrates a linear playback-rate ramp.
            expect(2 * (target - position) / 1.12).toBeLessThanOrEqual(0.251);
        }
    }
    expect(levelUpPauseTarget([], 7, 20)).toBeCloseTo(7.1);
    expect(levelUpPauseTarget([], 19.95, 20)).toBe(20);
    const gap = generateTimeline(30, 120).filter(beat => beat.time < 2 || beat.time > 20)
        .map((beat, index) => ({ ...beat, index }));
    expect(levelUpPauseTarget(gap, 5, 30)).toBeCloseTo(5.1);
});
