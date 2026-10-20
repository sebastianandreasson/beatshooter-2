import { expect, test } from "bun:test";
import { beatEnvelope, beatMotionCoordinate, beatTravel, beatVelocity } from "./pulse";
import { generateTimeline } from "./timeline";
import { MusicalTimeline } from "./visual";

test("one continuous musical stride surges on the beat and holds before the next", () => {
    const timeline = new MusicalTimeline(generateTimeline(5, 120));
    expect(beatMotionCoordinate(timeline.sample(-1))).toBe(0);
    expect(beatTravel(0)).toBe(0);
    expect(beatEnvelope(0)).toBe(1);
    expect(beatVelocity(0)).toBeGreaterThan(3);
    let previous = 0;
    for (let i = 0; i <= 200; i++) {
        const coordinate = beatMotionCoordinate(timeline.sample(i / 100));
        expect(coordinate).toBeGreaterThanOrEqual(previous);
        previous = coordinate;
    }
    for (const phase of [0.55, 0.7, 0.99, 1]) {
        expect(beatTravel(phase)).toBe(1);
        expect(beatVelocity(phase)).toBe(0);
        expect(beatEnvelope(phase)).toBe(0);
    }
    expect(beatMotionCoordinate(timeline.sample(0.499999))).toBe(1);
    expect(beatMotionCoordinate(timeline.sample(0.5))).toBe(1);
    expect(beatMotionCoordinate(timeline.sample(0.6))).toBeGreaterThan(1);
    expect(beatMotionCoordinate(timeline.sample(0.3), 0.35)).toBeLessThan(1);
});

test("music pauses, irregular beats, gaps and retries do not depend on render history", () => {
    const times = [0, 0.5, 1.3, 1.8, 8, 8.5, 9];
    const timeline = new MusicalTimeline(generateTimeline(4, 120).slice(0, times.length)
        .map((beat, index) => ({ ...beat, time: times[index]! })));
    expect(beatMotionCoordinate(timeline.sample(1.1))).toBe(2);
    const held = beatMotionCoordinate(timeline.sample(3));
    for (const position of [3.1, 4, 5, 7.9]) expect(beatMotionCoordinate(timeline.sample(position))).toBe(held);
    expect(beatMotionCoordinate(timeline.sample(8.1))).toBeGreaterThan(held);
    const original = timeline.sample(0.08);
    for (let i = 0; i < 100; i++) timeline.sample(i / 10);
    expect(timeline.sample(0.08)).toEqual(original);
    expect(beatMotionCoordinate(timeline.sample(0))).toBe(0);
});
