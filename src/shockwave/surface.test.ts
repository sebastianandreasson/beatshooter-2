import { expect, test } from "bun:test";
import * as d from "typegpu/data";
import { SHOCKWAVE_MAX_LIFT, shockwaveHeight, shockwaveSurface } from "./surface";

test("one compact upward ridge crosses a world point and returns exactly to the original surface", () => {
    let risingIntervals = 0, wasRising = false;
    let last = 0;
    for (let frame = 0; frame <= 120; frame++) {
        const progress = frame / 120, height = shockwaveHeight(progress, 0.85, 12, 9);
        expect(height).toBeGreaterThanOrEqual(0);
        expect(height).toBeLessThanOrEqual(SHOCKWAVE_MAX_LIFT);
        const rising = height > last + 0.00001;
        if (rising && !wasRising) risingIntervals++;
        last = height; wasRising = rising;
    }
    expect(risingIntervals).toBe(1);
    expect(shockwaveHeight(0.5, 0.85, 12, 9)).toBeCloseTo(1.275, 6);
    for (const radius of [11.9, 12, 18, 18.1]) expect(shockwaveHeight(0.5, 0.85, radius, 0)).toBe(0);
    expect(shockwaveHeight(0.5, 0.85, 14, 0)).toBeCloseTo(shockwaveHeight(0.5, 0.85, 16, 0), 6);
});

test("start/end fades, zero strength and Calm are bounded without changing horizontal positions", () => {
    for (const progress of [0, 1, 1.1, -0.1]) {
        expect(shockwaveHeight(progress, 1, progress * 30, 0)).toBe(0);
    }
    expect(shockwaveHeight(0.5, 0, 15, 0)).toBe(0);
    expect(shockwaveHeight(0.5, -1, 15, 0)).toBe(0);
    expect(shockwaveHeight(0.5, 8, 15, 0)).toBeCloseTo(SHOCKWAVE_MAX_LIFT);
    expect(shockwaveHeight(0.03, 1, 0.9, 0)).toBeCloseTo(0.75);
    expect(shockwaveHeight(0.94, 1, 28.2, 0)).toBeCloseTo(0.75);
    const calm = shockwaveSurface(0.5, 0.22, d.vec3f(12, 0.55, 9), d.vec3f(0, 1, 0));
    expect(calm.position.x).toBe(12);
    expect(calm.position.z).toBe(9);
    expect(calm.lift).toBeCloseTo(0.33);
    expect(calm.position.y).toBeCloseTo(0.88);
});

test("adjusted normals are perpendicular to the deformed surface's local tangents", () => {
    const x = 10.5, z = 8, progress = 0.5, strength = 0.85, step = 0.01;
    const dx = (shockwaveHeight(progress, strength, x + step, z)
        - shockwaveHeight(progress, strength, x - step, z)) / (step * 2);
    const dz = (shockwaveHeight(progress, strength, x, z + step)
        - shockwaveHeight(progress, strength, x, z - step)) / (step * 2);
    const { normal } = shockwaveSurface(progress, strength, d.vec3f(x, 2, z), d.vec3f(0, 1, 0));
    expect(normal.x + dx * normal.y).toBeCloseTo(0, 4);
    expect(normal.z + dz * normal.y).toBeCloseTo(0, 4);
    expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 6);
    expect(normal.y).toBeGreaterThan(0);
});

test("CPU anchors and all rendering passes use identical displacement, independent of vertex normals", () => {
    for (const progress of [0, 0.03, 0.3, 0.5, 0.94, 1]) {
        for (const [x, z] of [[0, 0], [3, 4], [12, 9], [-13, 8], [20, 20]]) {
            const position = d.vec3f(x!, -0.15, z!);
            const normal = shockwaveSurface(progress, 0.85, position, d.vec3f(0, 1, 0));
            const depth = shockwaveSurface(progress, 0.85, position, d.vec3f(0, 0, 1));
            expect(normal.lift).toBeCloseTo(shockwaveHeight(progress, 0.85, x!, z!), 6);
            expect(depth.position).toEqual(normal.position);
            expect(depth.normal.x).toBe(0);
            expect(depth.normal.y).toBe(0);
            expect(depth.normal.z).toBe(1);
            expect(Number.isFinite(normal.normal.x + normal.normal.y + normal.normal.z)).toBe(true);
        }
    }
});
