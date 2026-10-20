import { expect, test } from "bun:test";
import { createSubdividedBox, waveCullBounds } from "./geometry";

test("the dense floor is a bounded closed unit box with outward winding and half-unit world cells", () => {
    const mesh = createSubdividedBox([37, 0.5, 37]);
    expect(mesh.segments).toEqual([74, 1, 74]);
    expect(mesh.vertices.length / 8).toBe(11850);
    expect(mesh.indices.length / 3).toBe(22496);
    const points: string[] = [];
    let minCoordinate = Infinity, maxCoordinate = -Infinity;
    let badNormals = 0, badUvs = 0, minWinding = Infinity;
    for (let offset = 0; offset < mesh.vertices.length; offset += 8) {
        const x = mesh.vertices[offset]!, y = mesh.vertices[offset + 1]!, z = mesh.vertices[offset + 2]!;
        minCoordinate = Math.min(minCoordinate, x, y, z);
        maxCoordinate = Math.max(maxCoordinate, x, y, z);
        points.push([x, y, z].map(value => value.toFixed(6)).join(","));
        if (Math.hypot(...mesh.vertices.slice(offset + 4, offset + 7)) !== 1) badNormals++;
        if (mesh.vertices[offset + 3]! < 0 || mesh.vertices[offset + 3]! > 1 ||
            mesh.vertices[offset + 7]! < 0 || mesh.vertices[offset + 7]! > 1) badUvs++;
    }
    const edges = new Map<string, number>();
    for (let index = 0; index < mesh.indices.length; index += 3) {
        const a = mesh.indices[index]!, b = mesh.indices[index + 1]!, c = mesh.indices[index + 2]!;
        const ax = mesh.vertices[b * 8]! - mesh.vertices[a * 8]!;
        const ay = mesh.vertices[b * 8 + 1]! - mesh.vertices[a * 8 + 1]!;
        const az = mesh.vertices[b * 8 + 2]! - mesh.vertices[a * 8 + 2]!;
        const bx = mesh.vertices[c * 8]! - mesh.vertices[a * 8]!;
        const by = mesh.vertices[c * 8 + 1]! - mesh.vertices[a * 8 + 1]!;
        const bz = mesh.vertices[c * 8 + 2]! - mesh.vertices[a * 8 + 2]!;
        const normalDot = (ay * bz - az * by) * mesh.vertices[a * 8 + 4]!
            + (az * bx - ax * bz) * mesh.vertices[a * 8 + 5]!
            + (ax * by - ay * bx) * mesh.vertices[a * 8 + 6]!;
        minWinding = Math.min(minWinding, normalDot);
        for (const [start, end] of [[a, b], [b, c], [c, a]]) {
            const key = [points[start!]!, points[end!]!].sort().join("|");
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    expect(minCoordinate).toBe(-0.5);
    expect(maxCoordinate).toBe(0.5);
    expect(badNormals).toBe(0);
    expect(badUvs).toBe(0);
    expect(minWinding).toBeGreaterThan(0);
    expect([...edges.values()].every(count => count === 2)).toBe(true);
});

test("walls and fallback lines have interior vertices along their long axis without changing box dimensions", () => {
    for (const size of [[38, 0.8, 1], [1, 0.8, 38], [0.035, 0.025, 36], [36, 0.025, 0.035]] as const) {
        const mesh = createSubdividedBox(size);
        const longAxis = size[0] > size[2] ? 0 : 2;
        const coordinates = new Set<number>();
        for (let offset = 0; offset < mesh.vertices.length; offset += 8) {
            coordinates.add(mesh.vertices[offset + longAxis]!);
        }
        expect(coordinates.size).toBe(mesh.segments[longAxis] + 1);
        const ordered = [...coordinates].sort((a, b) => a - b);
        expect(ordered[0]).toBe(-0.5);
        expect(ordered.at(-1)).toBe(0.5);
        let largestWorldCell = 0;
        for (let i = 1; i < ordered.length; i++) {
            largestWorldCell = Math.max(largestWorldCell, (ordered[i]! - ordered[i - 1]!) * size[longAxis]);
        }
        expect(largestWorldCell).toBeLessThanOrEqual(0.50001);
        expect(mesh.vertices.length / 8).toBeLessThan(1000);
    }
});

test("render culling covers lifted vertices and invalid geometry cannot allocate unbounded grids", () => {
    for (const size of [[37, 0.5, 37], [1, 0.8, 38], [0.035, 0.025, 36], [0.14, 0.14, 0.65]] as const) {
        const bounds = waveCullBounds(size);
        const worldRadius = bounds[3] * Math.max(...size);
        const liftedCorner = Math.hypot(size[0] / 2, size[1] / 2 + 1.5, size[2] / 2);
        expect(worldRadius).toBeGreaterThanOrEqual(liftedCorner);
        expect(bounds.slice(0, 3)).toEqual([0, 0, 0]);
    }
    for (const spacing of [0, -1, NaN, Infinity]) {
        expect(() => createSubdividedBox([1, 1, 1], spacing)).toThrow(RangeError);
    }
    expect(() => createSubdividedBox([1, 0, 1])).toThrow(RangeError);
    const bounded = createSubdividedBox([1000, 0.5, 1000]);
    expect(bounded.segments).toEqual([128, 1, 128]);
    expect(bounded.vertices.length / 8).toBeLessThan(35000);
});
