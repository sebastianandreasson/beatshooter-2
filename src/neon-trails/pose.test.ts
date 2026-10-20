import { expect, test } from "bun:test";
import { sampleTrailPose, trailGeometry, type TrailPose } from "./pose";

const blank = (): TrailPose => ({ x: 0, y: 0, z: 0, width: 0, length: 0, yaw: 0 });

test("tails grow by song age and local beat duration, with bounded lengths and a smaller Calm pose", () => {
    const fresh = sampleTrailPose(4, 3, 32, 0, 0, 0.5, false, false, blank());
    expect(fresh.length).toBe(0);
    const young = sampleTrailPose(4, 3, 32, 0, 0.02, 0.5, false, false, blank());
    expect(young.length).toBeCloseTo(0.41);
    const full = sampleTrailPose(4, 3, 32, 0, 2, 0.5, false, false, blank());
    expect(full.length).toBeCloseTo(1.69);
    expect(full.x + full.length / 2).toBeCloseTo(4 - 0.23);
    expect(full.z).toBe(3);
    expect(full.yaw).toBeCloseTo(Math.PI / 2);
    const fastBeat = sampleTrailPose(4, 3, 32, 0, 2, 0.25, false, false, blank());
    expect(fastBeat.length).toBeLessThan(full.length);
    expect(sampleTrailPose(4, 3, 32, 0, 2, 2, false, false, blank()).length).toBe(2);
    const calm = sampleTrailPose(4, 3, 32, 0, 2, 0.5, false, true, blank());
    expect(calm.length).toBeLessThan(full.length);
    expect(calm.width).toBeLessThan(full.width);
    const hostile = sampleTrailPose(4, 3, 0, -9, 2, 2, true, false, blank());
    expect(hostile.length).toBe(1.2);
    expect(hostile.z - hostile.length / 2).toBeCloseTo(3 + 0.11);
    expect(sampleTrailPose(0, 0, 0, 0, 1, 0.5, false, false, blank()).length).toBe(0);
    expect(sampleTrailPose(0, 0, NaN, 0, 1, 0.5, false, false, blank()).length).toBe(0);
});

test("the pooled tapered mesh has a fine trailing tip and outward faces", () => {
    const { vertices, indices } = trailGeometry();
    expect(vertices.length / 8).toBe(24);
    expect(indices.length / 3).toBe(12);
    const front: number[] = [], back: number[] = [];
    for (let i = 0; i < vertices.length; i += 8) {
        (vertices[i + 2]! > 0 ? front : back).push(Math.abs(vertices[i]!));
        expect(Math.hypot(vertices[i + 4]!, vertices[i + 5]!, vertices[i + 6]!)).toBeCloseTo(1);
    }
    expect(Math.max(...front)).toBe(0.5);
    expect(Math.max(...back)).toBeCloseTo(0.04);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]! * 8, b = indices[i + 1]! * 8, c = indices[i + 2]! * 8;
        const u = [vertices[b]! - vertices[a]!, vertices[b + 1]! - vertices[a + 1]!, vertices[b + 2]! - vertices[a + 2]!];
        const v = [vertices[c]! - vertices[a]!, vertices[c + 1]! - vertices[a + 1]!, vertices[c + 2]! - vertices[a + 2]!];
        const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        expect(normal[0]! * vertices[a + 4]! + normal[1]! * vertices[a + 5]! + normal[2]! * vertices[a + 6]!).toBeGreaterThan(0);
        expect(normal[0]! * vertices[a]! + normal[1]! * vertices[a + 1]! + normal[2]! * vertices[a + 2]!).toBeGreaterThan(0);
    }
});
