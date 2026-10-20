import { describe, expect, test } from "bun:test";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import { MAX_DASH_DISTANCE } from "../player-stats";
import { DASH_DISTANCE, DashController } from "./state";
import { createDashTiming } from "./timing";

const movement = { x: 1, z: 0 };
const aim = { x: 0, z: -1 };
const controller = (bpm = 120) => new DashController(createDashTiming(generateTimeline(30, bpm)));

describe("one-per-bar dash controller", () => {
    test("reset immediately clears a running dash and re-arms earlier bars", () => {
        const dash = controller();
        const timing = dash.timing;
        expect(dash.press(2, movement, aim)).toBe(true);
        expect(dash.accepted).toBe(1);
        expect(dash.active).toBeDefined();

        dash.reset();

        // No update(): callers can inspect the cleared state synchronously.
        expect(dash.active).toBeUndefined();
        expect(dash.accepted).toBe(0);
        expect(dash.lastUsedBeat).toBe(-1);
        expect(dash.lastUsedBar).toBe(-1);
        expect(dash.timing).toBe(timing);
        expect(dash.status(0)).toBe("ready");
        expect(dash.press(0, movement, aim)).toBe(true);
        expect(dash.active?.beatIndex).toBe(0);
        expect(dash.accepted).toBe(1);
    });

    test("an early accepted press consumes the new bar, including after crossing its first beat", () => {
        const dash = controller();
        expect(dash.status(1.85)).toBe("ready");
        expect(dash.press(1.85, movement, aim)).toBe(true);
        const first = structuredClone(dash.active);
        expect(dash.status(1.95)).toBe("dashing");
        expect(dash.press(1.95, movement, aim)).toBe(false);
        expect(dash.active).toEqual(first);
        dash.update(2.04);
        expect(dash.active).toBeUndefined();
        expect(dash.status(2.04)).toBe("used");
        expect(dash.press(2.09, movement, aim)).toBe(false);
        expect(dash.accepted).toBe(1);
        expect(dash.lastUsedBeat).toBe(4);
        expect(dash.lastUsedBar).toBe(1);
        expect(dash.press(2.5, movement, aim)).toBe(false);
        expect(dash.status(2.75)).toBe("used");
    });

    test("offbeat presses never buffer a dash or spend the next beat", () => {
        const dash = controller();
        for (const position of [0.25, 0.75, 1.25, 1.849]) {
            expect(dash.press(position, movement, aim)).toBe(false);
            expect(dash.active).toBeUndefined();
        }
        dash.update(2);
        expect(dash.status(2)).toBe("ready");
        expect(dash.active).toBeUndefined();
        expect(dash.accepted).toBe(0);
        expect(dash.press(2, movement, aim)).toBe(true);
        expect(dash.accepted).toBe(1);
    });

    test("a fresh press re-arms at the next authored downbeat without an elapsed-time cooldown", () => {
        const dash = controller();
        expect(dash.press(0, movement, aim)).toBe(true);
        dash.update(0.3);
        expect(dash.status(1)).toBe("used");
        expect(dash.press(1, movement, aim)).toBe(false);
        expect(dash.status(1.9)).toBe("ready");
        expect(dash.press(1.9, movement, aim)).toBe(true);
        expect(dash.active?.beatIndex).toBe(4);
        dash.update(3);
        expect(dash.press(4, movement, aim)).toBe(true);
        expect(dash.active?.beatIndex).toBe(8);
        expect(dash.accepted).toBe(3);
    });

    test("any beat can spend the bar's single dash, including its last beat", () => {
        for (const beat of [0, 1, 2, 3]) {
            const dash = controller();
            const position = beat * .5;
            expect(dash.status(position)).toBe("ready");
            expect(dash.press(position, movement, aim)).toBe(true);
            expect(dash.lastUsedBeat).toBe(beat);
            expect(dash.lastUsedBar).toBe(0);
            expect(dash.press(position + .05, movement, aim)).toBe(false);
            for (let later = beat + 1; later < 4; later++) {
                expect(dash.press(later * .5, movement, aim)).toBe(false);
            }
            expect(dash.status(1.8)).toBe("used");
            expect(dash.press(2, movement, aim)).toBe(true);
            expect(dash.lastUsedBar).toBe(1);
            expect(dash.press(2.5, movement, aim)).toBe(false);
            expect(dash.accepted).toBe(2);
        }
    });

    test("changing tempo, pickups and inferred mixed-meter bars reset without a fixed timer", () => {
        const times = [.2, .7, 1.1, 1.55, 2.1, 2.7, 3.35, 4, 4.7];
        const starts = [0, 1, 4, 8];
        const beats: Beat[] = times.map((time, index) => {
            const bar = starts.findLastIndex(start => start <= index);
            return { time, index, bar, beatInBar: index === 0 ? 2 : index - starts[bar]!, downbeat: false };
        });
        const dash = new DashController(createDashTiming(beats));
        expect(dash.press(.2, movement, aim)).toBe(true);
        // First full bar is 3 beats; use its second beat.
        expect(dash.press(1.1, movement, aim)).toBe(true);
        expect(dash.press(1.55, movement, aim)).toBe(false);
        expect(dash.status(1.8)).toBe("used");
        // Next bar has 4 beats; skip its first three and use the last one.
        expect(dash.status(2.1)).toBe("ready");
        expect(dash.press(4, movement, aim)).toBe(true);
        expect(dash.press(4.05, movement, aim)).toBe(false);
        expect(dash.press(4.7, movement, aim)).toBe(true);
        expect(dash.accepted).toBe(4);
    });

    test("movement determines a normalized direction, with aim and neutral fallbacks", () => {
        const diagonal = controller();
        expect(diagonal.press(0, { x: 3, z: 4 }, { x: -1, z: 0 })).toBe(true);
        expect(diagonal.active!.direction.x).toBeCloseTo(0.6, 12);
        expect(diagonal.active!.direction.z).toBeCloseTo(0.8, 12);
        expect(Math.hypot(diagonal.active!.direction.x, diagonal.active!.direction.z)).toBeCloseTo(1, 12);
        const aiming = controller();
        expect(aiming.press(0, { x: 0, z: 0 }, { x: -4, z: 3 })).toBe(true);
        expect(aiming.active!.direction).toEqual({ x: -0.8, z: 0.6 });
        const neutral = controller();
        expect(neutral.press(0, { x: 0, z: 0 }, { x: 0, z: 0 })).toBe(true);
        expect(neutral.active!.direction).toEqual({ x: 0, z: -1 });
    });

    test("an active dash owns its origin and direction after input objects change", () => {
        const dash = controller();
        const origin = { x: 4, z: -3 };
        const input = { x: 3, z: 4 };
        expect(dash.press(2, input, aim, origin)).toBe(true);
        origin.x = 99;
        origin.z = 99;
        input.x = -1;
        input.z = 0;
        expect(dash.active!.origin).toEqual({ x: 4, z: -3 });
        expect(dash.active!.direction).toEqual({ x: 0.6, z: 0.8 });
    });

    test("the musical quarter-beat duration stays bounded with a constant nominal target distance", () => {
        for (const [bpm, expectedDuration] of [[20, 0.18], [120, 0.125], [300, 0.08]] as const) {
            const dash = controller(bpm);
            expect(dash.press(0, movement, aim)).toBe(true);
            const active = dash.active!;
            const duration = active.endsAt - active.startedAt;
            expect(duration).toBeCloseTo(expectedDuration, 12);
            expect(active.speed * duration).toBeCloseTo(DASH_DISTANCE, 12);
            expect(active.speed).toBeGreaterThanOrEqual(20);
            expect(active.speed).toBeLessThanOrEqual(45);
            dash.update(active.endsAt - 0.000001);
            expect(dash.active).toBeDefined();
            dash.update(active.endsAt);
            expect(dash.active).toBeUndefined();
        }
    });

    test("duration follows the detected local interval and does not assume a fixed BPM", () => {
        const beats: Beat[] = [0, 0.5, 1, 1.5, 2, 2.6, 3.2, 3.8, 4.4].map((time, index) => ({
            time, index, bar: Math.floor(index / 4), beatInBar: index % 4,
            downbeat: index % 4 === 0,
        }));
        const dash = new DashController(createDashTiming(beats));
        expect(dash.press(2, movement, aim)).toBe(true);
        expect(dash.active!.endsAt - dash.active!.startedAt).toBeCloseTo(0.15, 12);
        expect(dash.active!.speed).toBeCloseTo(24, 12);
    });

    test("fractional upgraded distance keeps the same musical duration and caps speed at ninety", () => {
        for (const [bpm, duration] of [[20, 0.18], [120, 0.125], [300, 0.08]] as const) {
            for (const distance of [4.2, MAX_DASH_DISTANCE, 100]) {
                const dash = controller(bpm);
                expect(dash.press(0, movement, aim, undefined, distance)).toBe(true);
                const active = dash.active!;
                expect(active.endsAt - active.startedAt).toBeCloseTo(duration, 12);
                expect(active.distance).toBe(Math.min(distance, MAX_DASH_DISTANCE));
                expect(active.speed * duration).toBeCloseTo(active.distance, 12);
                expect(active.speed).toBeLessThanOrEqual(90);
            }
        }
    });

    test("disabled or invalid distance does not spend a bar, and reset discards the distance snapshot", () => {
        const dash = controller();
        for (const distance of [0, -1, NaN, Infinity, -Infinity]) {
            expect(dash.press(0, movement, aim, undefined, distance)).toBe(false);
            expect(dash.accepted).toBe(0);
            expect(dash.lastUsedBar).toBe(-1);
        }
        expect(dash.press(0, movement, aim, undefined, 7.2)).toBe(true);
        expect(dash.active!.distance).toBe(7.2);
        dash.reset();
        expect(dash.active).toBeUndefined();
        expect(dash.press(0, movement, aim)).toBe(true);
        expect(dash.active!.distance).toBe(DASH_DISTANCE);
        expect(dash.active!.speed).toBeCloseTo(DASH_DISTANCE / 0.125, 12);
    });

    test("a held song position freezes the active dash through any number of paused renders", () => {
        const dash = controller();
        expect(dash.press(2, movement, aim)).toBe(true);
        dash.update(2.04);
        const held = structuredClone(dash.active);
        for (let frame = 0; frame < 1440; frame++) {
            dash.update(2.04);
        }
        expect(dash.status(2.04)).toBe("dashing");
        expect(dash.active).toEqual(held);
        expect(dash.accepted).toBe(1);
        dash.update(2.124);
        expect(dash.active).toBeDefined();
        dash.update(2.125);
        expect(dash.active).toBeUndefined();
    });

    test("count-in and nonfinite positions reject input, while unaccented detected beats remain usable", () => {
        const dash = controller();
        for (const position of [-2, -0.01, NaN, Infinity, -Infinity]) {
            expect(dash.press(position, movement, aim)).toBe(false);
        }
        expect(dash.accepted).toBe(0);
        expect(dash.lastUsedBeat).toBe(-1);
        const inferred = new DashController(createDashTiming(
            generateTimeline(10, 120).map(beat => ({ ...beat, downbeat: false })),
        ));
        expect(inferred.press(2.5, movement, aim)).toBe(true);
        expect(inferred.press(3, movement, aim)).toBe(false);
        expect(inferred.status(4)).toBe("ready");
    });
});
