import { expect, test } from "bun:test";
import * as d from "typegpu/data";
import { boxEdgeCoordinate, neonEdgeEmission } from "./edges";

test("neon box edges glow on every orientation while the middle of a face stays dark", () => {
    const mint = d.vec3f(0.3, 2.5, 1.8);
    for (const position of [d.vec3f(0.5, 0.5, 0), d.vec3f(-0.5, 0, 0.5), d.vec3f(0, -0.5, -0.5)]) {
        const edge = neonEdgeEmission(boxEdgeCoordinate(position), 0.005, mint);
        expect(edge.y).toBeGreaterThan(2);
        expect(edge.y).toBeLessThanOrEqual(mint.y);
        expect(edge.x / edge.y).toBeCloseTo(mint.x / mint.y);
    }
    for (const position of [d.vec3f(0.5, 0, 0), d.vec3f(0, -0.5, 0), d.vec3f(0, 0, 0.5)]) {
        const face = neonEdgeEmission(boxEdgeCoordinate(position), 0.005, mint);
        expect(face.y).toBeLessThan(0.1);
    }
});

test("small projected edges remain finite and soften without losing their color", () => {
    const coral = d.vec3f(2.5, 0.4, 0.3);
    for (const footprint of [0, 0.001, 0.01, 0.2]) {
        const near = neonEdgeEmission(0.48, footprint, coral);
        expect(Number.isFinite(near.x + near.y + near.z)).toBe(true);
        expect(near.x).toBeGreaterThan(0);
        expect(near.x).toBeLessThanOrEqual(coral.x);
        expect(near.y / near.x).toBeCloseTo(coral.y / coral.x);
    }
});
