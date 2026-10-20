import { describe, expect, test } from "bun:test";
import { enemySpawnPose } from "./pose";

const full = { motionAllowed: true, intensity: 0.85 };

describe("enemy arrivals follow their authored beat interval", () => {
    test("scale and descent reach the live body exactly on the activation beat at 20–300 BPM", () => {
        for (const bpm of [20, 73, 120, 191, 300]) {
            const start = 7.37, end = start + 60 / bpm;
            const birth = enemySpawnPose(start, end, start, full);
            expect(birth.scale).toBe(0);
            expect(birth.y).toBeCloseTo(2.65);
            expect(birth.yaw - Math.PI / 4).toBeCloseTo(Math.PI * 2);
            const middle = enemySpawnPose(start, end, (start + end) / 2, full);
            expect(middle.progress).toBeCloseTo(0.5);
            expect(middle.scale).toBeCloseTo(0.5);
            expect(middle.beamWidth).toBeGreaterThan(0);
            expect(middle.beamCoreWidth).toBeCloseTo(1.2);
            const ready = enemySpawnPose(start, end, end, full);
            expect(ready.progress).toBe(1);
            expect(ready.scale).toBe(1);
            expect(ready.y).toBe(0.55);
            expect(ready.yaw).toBe(Math.PI / 4);
            expect(ready.beamWidth).toBe(0);
            expect(ready.beamCoreWidth).toBe(0);
            expect(ready.outlineWidth).toBe(0);
            expect(enemySpawnPose(start, end, end + 1, full)).toEqual(ready);
        }
    });

    test("irregular intervals use their actual endpoints, and holding music position freezes every channel", () => {
        for (const [start, end] of [[0.13, 0.53], [0.53, 1.24], [1.24, 1.46]]) {
            const position = start! + (end! - start!) * 0.375;
            const held = enemySpawnPose(start!, end!, position, full);
            expect(held.progress).toBeCloseTo(0.375);
            for (let frame = 0; frame < 100; frame++) {
                expect(enemySpawnPose(start!, end!, position, full)).toEqual(held);
            }
            expect(enemySpawnPose(start!, end!, start! + (end! - start!) * 0.5, full).scale)
                .toBeGreaterThan(held.scale);
        }
    });

    test("growth is monotonic and beam geometry stays finite throughout the beat", () => {
        let previousScale = 0;
        for (let i = 0; i <= 100; i++) {
            const pose = enemySpawnPose(3.2, 3.77, 3.2 + 0.57 * i / 100, full);
            expect(pose.scale).toBeGreaterThanOrEqual(previousScale);
            expect(pose.scale).toBeLessThanOrEqual(1);
            expect(pose.beamBottom).toBeLessThanOrEqual(pose.beamTop);
            expect(Object.values(pose).every(Number.isFinite)).toBe(true);
            previousScale = pose.scale;
        }
    });

    test("calm reduces flourish and reduced motion retains stationary, musical growth and a floor marker", () => {
        const standard = enemySpawnPose(1, 1.5, 1.2, full);
        const calm = enemySpawnPose(1, 1.5, 1.2, { motionAllowed: true, intensity: 0.3 });
        expect(calm.scale).toBe(standard.scale);
        expect(calm.y).toBeLessThan(standard.y);
        expect(calm.yaw).toBeLessThan(standard.yaw);
        expect(calm.beamWidth).toBeLessThan(standard.beamWidth);
        for (const intensity of [0, 0.18, 0.85]) {
            const steady = enemySpawnPose(1, 1.5, 1.2, { motionAllowed: false, intensity });
            expect(steady.scale).toBe(standard.scale);
            expect(steady.y).toBe(0.55);
            expect(steady.yaw).toBe(Math.PI / 4);
            expect(steady.beamWidth).toBe(0);
            expect(steady.beamCoreWidth).toBe(0);
            expect(steady.outlineWidth).toBeGreaterThan(0);
        }
    });
});
