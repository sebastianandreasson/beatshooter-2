import { expect, test } from "bun:test";
import { createPlayerShipGeometry, SHIP_ENGINE_OFFSETS, type ShipMeshData } from "./ship-geometry";

function bounds(mesh: ShipMeshData) {
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < mesh.vertices.length; offset += 8) {
        for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis]!, mesh.vertices[offset + axis]!);
            maximum[axis] = Math.max(maximum[axis]!, mesh.vertices[offset + axis]!);
        }
    }
    return { minimum, maximum };
}

test("fighter geometry has a broad swept silhouette, pointed forward nose, and raised cockpit", () => {
    const ship = createPlayerShipGeometry(), hull = bounds(ship.hull), cockpit = bounds(ship.cockpit);
    expect(hull.minimum[0]).toBeCloseTo(-1.04);
    expect(hull.maximum[0]).toBeCloseTo(1.04);
    expect(hull.minimum[2]).toBeCloseTo(-1.05);
    expect(hull.maximum[2]).toBeCloseTo(0.76);
    expect(cockpit.maximum[1]).toBeGreaterThan(hull.maximum[1]! + 0.1);
    let widestForwardPoint = 0;
    for (let offset = 0; offset < ship.hull.vertices.length; offset += 8) {
        if (ship.hull.vertices[offset + 2]! < -0.9) {
            widestForwardPoint = Math.max(widestForwardPoint, Math.abs(ship.hull.vertices[offset]!));
        }
    }
    expect(widestForwardPoint).toBe(0);
    const left = bounds(ship.wings[0]), right = bounds(ship.wings[1]);
    expect(left.minimum[0]).toBeCloseTo(-right.maximum[0]!);
    expect(left.maximum[0]).toBeCloseTo(-right.minimum[0]!);
    expect(left.maximum[1]).toBeCloseTo(right.maximum[1]!);
});

test("every mesh has bounded finite staging data and consistently wound flat normals", () => {
    const ship = createPlayerShipGeometry();
    const parts = [ship.hull, ship.cockpit, ...ship.wings, ship.edges, ...ship.nozzles, ship.exhaust];
    let vertices = 0, minimumArea = Infinity;
    for (const mesh of parts) {
        vertices += mesh.vertices.length / 8;
        expect(mesh.vertices.length % 8).toBe(0);
        expect(mesh.indices.length % 3).toBe(0);
        expect([...mesh.vertices].every(Number.isFinite)).toBe(true);
        for (let index = 0; index < mesh.indices.length; index += 3) {
            const a = mesh.indices[index]! * 8, b = mesh.indices[index + 1]! * 8, c = mesh.indices[index + 2]! * 8;
            expect(Math.max(a, b, c)).toBeLessThan(mesh.vertices.length);
            const ab = [0, 1, 2].map(axis => mesh.vertices[b + axis]! - mesh.vertices[a + axis]!);
            const ac = [0, 1, 2].map(axis => mesh.vertices[c + axis]! - mesh.vertices[a + axis]!);
            const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!,
                ab[0]! * ac[1]! - ab[1]! * ac[0]!];
            const area = Math.hypot(...cross);
            minimumArea = Math.min(minimumArea, area);
            const normal = [...mesh.vertices.slice(a + 4, a + 7)];
            expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
            expect(cross.reduce((sum, value, axis) => sum + value * normal[axis]!, 0)).toBeCloseTo(area, 5);
        }
    }
    expect(minimumArea).toBeGreaterThan(0.00001);
    expect(vertices).toBeLessThan(2500);
});

test("both engine outlets include an upward-facing readiness plate and anchored backward exhaust", () => {
    const ship = createPlayerShipGeometry();
    for (const [index, nozzle] of ship.nozzles.entries()) {
        const anchor = SHIP_ENGINE_OFFSETS[index]!;
        const box = bounds(nozzle);
        expect(box.maximum[2]).toBeCloseTo(anchor[2]);
        expect((box.minimum[0]! + box.maximum[0]!) / 2).toBeCloseTo(anchor[0]);
        let topArea = 0;
        for (let offset = 0; offset < nozzle.vertices.length; offset += 8) {
            if (nozzle.vertices[offset + 1]! > 0.12 && nozzle.vertices[offset + 5]! > 0.99) topArea++;
        }
        expect(topArea).toBeGreaterThanOrEqual(6);
    }
    const exhaust = bounds(ship.exhaust);
    expect(exhaust.minimum[2]).toBe(0);
    expect(exhaust.maximum[2]).toBe(1);
    expect(exhaust.minimum[0]).toBeCloseTo(-0.5);
    expect(exhaust.maximum[0]).toBeCloseTo(0.5);
});
