import { expect, test } from "bun:test";
import { createStarSeeds, sampleStarPose, STAR_COUNT, type StarPose } from "./pose";

const empty = (): StarPose => ({ x: 0, y: 0, z: 0, width: 0, length: 0 });
const viewLength = Math.hypot(32, 19);

test("seeded depth layers have constant baseline travel and stay behind the arena inside the camera range", () => {
    const seeds = createStarSeeds();
    expect(seeds).toHaveLength(STAR_COUNT);
    expect(seeds).toHaveLength(960);
    expect(createStarSeeds()).toEqual(seeds);
    expect(new Set(seeds.map(seed => seed.depth))).toEqual(new Set([64, 80, 96]));
    for (const seed of seeds) {
        const fixed = { ...seed, phase: 0.4 };
        const start = sampleStarPose(fixed, 0, 0, empty());
        const after = sampleStarPose(fixed, 1, 0, empty());
        expect(Math.hypot(after.x - start.x, after.y - start.y, after.z - start.z))
            .toBeCloseTo(seed.rate * 45);
        for (const distance of [0, 10, 50]) {
            const pose = sampleStarPose(seed, distance, 1, empty());
            expect(pose.y).toBeLessThan(-20);
            const depth = -(pose.y * 32 + pose.z * 19) / viewLength;
            expect(depth).toBeCloseTo(seed.depth);
            expect(depth + viewLength).toBeLessThan(150);
            expect(pose.length).toBeGreaterThanOrEqual(pose.width);
            expect(pose.width).toBeLessThan(0.081);
            expect(pose.length).toBeLessThan(10.1);
        }
    }
});

test("star recycling fades both ends to zero and a boost adds a trailing streak without moving its head", () => {
    const seed = { ...createStarSeeds(1)[0]!, phase: 0.4 };
    const before = sampleStarPose(seed, (1 - seed.phase - 1e-7) / seed.rate, 1, empty());
    const after = sampleStarPose(seed, (1 - seed.phase + 1e-7) / seed.rate, 1, empty());
    expect(before.width).toBeLessThan(1e-9);
    expect(before.length).toBeLessThan(1e-8);
    expect(after.width).toBeLessThan(1e-9);
    expect(after.length).toBeLessThan(1e-8);
    const normal = sampleStarPose(seed, 1, 0, empty());
    const boosted = sampleStarPose(seed, 1, 1, empty());
    expect(boosted.length).toBeGreaterThan(normal.length * 20);
    const centerRadius = (pose: StarPose): number => {
        const screenY = pose.y * 19 / viewLength - pose.z * 32 / viewLength;
        return Math.hypot(pose.x, screenY);
    };
    expect(centerRadius(boosted) + (boosted.length - boosted.width) * 0.5)
        .toBeCloseTo(centerRadius(normal));
    const destination = empty();
    expect(sampleStarPose(seed, 1, 0.5, destination)).toBe(destination);
    expect(sampleStarPose(seed, 1, 0.5, empty())).toEqual(destination);
});
