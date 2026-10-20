import { describe, expect, test } from "bun:test";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import { sampleMenuUpgradeFeedback, UpgradeFeedback, type UpgradeFeedbackFrame } from "./upgrade-feedback";

function chart(times: number[]): Beat[] {
    return times.map((time, index) => ({
        time, index, bar: Math.floor(index / 4), beatInBar: index % 4, downbeat: index % 4 === 0,
    }));
}

function expectFinished(frame: UpgradeFeedbackFrame): void {
    expect(frame).toEqual({ selectedOpacity: 0, dismissedOpacity: 0, flash: 0, scale: 1, done: true });
}

describe("upgrade choice confirmation", () => {
    test("dismisses the other cards immediately and confirms once on the next authored beat", () => {
        const feedback = new UpgradeFeedback(generateTimeline(5, 120), 0.1);
        expect(feedback.sample(0.1)).toEqual({
            selectedOpacity: 1, dismissedOpacity: 1, flash: 0, scale: 1, done: false,
        });
        expect(feedback.sample(0.1875).dismissedOpacity).toBeCloseTo(0.5);
        expect(feedback.sample(0.275).dismissedOpacity).toBe(0);
        expect(feedback.sample(0.499).selectedOpacity).toBe(1);
        expect(feedback.sample(0.499).flash).toBe(0);
        expect(feedback.sample(0.5)).toEqual({
            selectedOpacity: 1, dismissedOpacity: 0, flash: 1, scale: 1.02, done: false,
        });
        expect(feedback.sample(0.5875).flash).toBeCloseTo(0.5);
        expect(feedback.sample(0.675).flash).toBe(0);
        expect(feedback.sample(0.8).selectedOpacity).toBe(1);
        expect(feedback.sample(0.9).selectedOpacity).toBeCloseTo(0.5);
        expectFinished(feedback.sample(1));
        expectFinished(feedback.sample(2));
    });

    test("variable tempo uses real beat intervals for both dismissal and the following fade", () => {
        const feedback = new UpgradeFeedback(chart([0, 0.4, 1.1, 1.6, 2.1]), 0.3);
        // Dismissal spans 0.25 of the short interval plus 0.1 of the next one.
        expect(feedback.sample(0.469).dismissedOpacity).toBeGreaterThan(0);
        expect(feedback.sample(0.47).dismissedOpacity).toBeCloseTo(0);
        expect(feedback.sample(0.4).flash).toBe(1);
        expect(feedback.sample(0.4 + 0.7 * 0.35).flash).toBe(0);
        expect(feedback.sample(0.4 + 0.7 * 0.6).selectedOpacity).toBeCloseTo(1);
        expect(feedback.sample(0.4 + 0.7 * 0.8).selectedOpacity).toBeCloseTo(0.5);
        expectFinished(feedback.sample(1.1));
    });

    test("an exact-on-beat choice confirms immediately and a held music clock freezes the result", () => {
        const beats = generateTimeline(5, 120);
        const feedback = new UpgradeFeedback(beats, 1);
        expect(feedback.sample(1).flash).toBe(1);
        expect(feedback.sample(1).dismissedOpacity).toBe(1);
        const held = feedback.sample(1.125);
        const later = feedback.sample(1.3);
        for (let draw = 0; draw < 120; draw++) expect(feedback.sample(1.125)).toEqual(held);
        for (const fps of [30, 60, 144]) {
            for (let draw = 0; draw / fps < 0.3; draw++) feedback.sample(1 + draw / fps);
            expect(feedback.sample(1.3)).toEqual(later);
        }
        expectFinished(feedback.sample(1.5));
        // A reset before the selection cannot resurrect its confirmation.
        expectFinished(feedback.sample(0));
        beats[2] = { ...beats[2]!, time: 3 };
        expect(feedback.sample(1.125)).toEqual(held);
    });

    test("a selection in or immediately before a gap fades quietly and never replays when beats return", () => {
        const beats = chart([0, 0.5, 1, 10, 10.5, 11, 11.5]);
        for (const birth of [0.75, 1, 2, 9.9, 11.5]) {
            const feedback = new UpgradeFeedback(beats, birth);
            expect(feedback.sample(birth).selectedOpacity).toBe(1);
            for (const elapsed of [0, 0.1, 0.3, 0.59]) {
                expect(feedback.sample(birth + elapsed).flash).toBe(0);
                expect(feedback.sample(birth + elapsed).scale).toBe(1);
            }
            expectFinished(feedback.sample(birth + 0.6));
            expectFinished(feedback.sample(20));
        }
        const beforeGap = new UpgradeFeedback(beats, 0.25);
        expect(beforeGap.sample(0.5).flash).toBe(1);
        expectFinished(beforeGap.sample(1));
        expectFinished(beforeGap.sample(10.5));
    });

    test("missing timing and nonfinite input finish safely without NaNs or manufactured flashes", () => {
        for (const beats of [[], chart([0]), chart([0, NaN])]) {
            const feedback = new UpgradeFeedback(beats, 2);
            expect(feedback.sample(2).selectedOpacity).toBe(1);
            expect(feedback.sample(2.2).flash).toBe(0);
            expectFinished(feedback.sample(2.6));
        }
        for (const invalid of [NaN, Infinity, -Infinity]) {
            expectFinished(new UpgradeFeedback(generateTimeline(5, 120), invalid).sample(1));
            expectFinished(new UpgradeFeedback(generateTimeline(5, 120), 1).sample(invalid));
        }
    });
});

describe("menu upgrade confirmation", () => {
    test("uses one soft flash and finishes after one and a quarter supplied beats", () => {
        const duration = 0.8;
        expect(sampleMenuUpgradeFeedback(0, duration)).toEqual({
            selectedOpacity: 1, dismissedOpacity: 1, flash: 0, scale: 1, done: false,
        });
        expect(sampleMenuUpgradeFeedback(0.25 * duration, duration).flash).toBe(0.65);
        expect(sampleMenuUpgradeFeedback(0.35 * duration, duration).dismissedOpacity).toBe(0);
        expect(sampleMenuUpgradeFeedback(0.6 * duration, duration).flash).toBe(0);
        expect(sampleMenuUpgradeFeedback(1.05 * duration, duration).selectedOpacity).toBeCloseTo(0.5);
        expectFinished(sampleMenuUpgradeFeedback(1.25 * duration, duration));
        expectFinished(sampleMenuUpgradeFeedback(100, duration));
        const held = sampleMenuUpgradeFeedback(0.3, duration);
        expect(sampleMenuUpgradeFeedback(0.3, duration)).toEqual(held);
    });

    test("invalid or extreme durations stay bounded and invalid elapsed time cannot leak NaNs", () => {
        for (const duration of [0, -1, NaN, Infinity, -Infinity, 1e99, 1e-99]) {
            const frame = sampleMenuUpgradeFeedback(0.01, duration);
            expect(Object.values(frame).every(value => typeof value !== "number" || Number.isFinite(value))).toBe(true);
            expectFinished(sampleMenuUpgradeFeedback(4, duration));
        }
        for (const elapsed of [-1, NaN, Infinity, -Infinity]) {
            expectFinished(sampleMenuUpgradeFeedback(elapsed, 0.5));
        }
    });
});
