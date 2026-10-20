type Point = readonly [number, number, number];

export interface ShipMeshData {
    /** Shallot staging layout: px, py, pz, u, nx, ny, nz, v. */
    vertices: Float32Array;
    indices: Uint32Array;
}

export const SHIP_ENGINE_OFFSETS: readonly [Point, Point] = [
    [-0.34, -0.015, 0.83], [0.34, -0.015, 0.83],
];

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (value: Point): Point => {
    const length = Math.hypot(...value);
    return [value[0] / length, value[1] / length, value[2] / length];
};

/** Small closed convex pieces keep the fighter faceted, with outward flat normals. */
class MeshBuilder {
    private vertices: number[] = [];
    private indices: number[] = [];

    triangle(a: Point, b: Point, c: Point): void {
        const normal = unit(cross(subtract(b, a), subtract(c, a)));
        const first = this.vertices.length / 8;
        for (const [index, point] of [a, b, c].entries()) {
            this.vertices.push(...point, index === 1 ? 1 : 0, ...normal, index === 2 ? 1 : 0);
            this.indices.push(first + index);
        }
    }

    convex(points: readonly Point[], faces: readonly (readonly number[])[]): void {
        const center = points.reduce<[number, number, number]>((sum, point) =>
            [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length,
                sum[2] + point[2] / points.length], [0, 0, 0]);
        for (const face of faces) {
            const a = points[face[0]!]!, b = points[face[1]!]!, c = points[face[2]!]!;
            const outward = dot(cross(subtract(b, a), subtract(c, a)), subtract(a, center)) > 0;
            for (let index = 1; index < face.length - 1; index++) {
                const second = points[face[index]!]!, third = points[face[index + 1]!]!;
                this.triangle(a, outward ? second : third, outward ? third : second);
            }
        }
    }

    /** Matching polygon loops; their caps and sides form one closed prism. */
    prism(front: readonly Point[], back: readonly Point[]): void {
        const count = front.length;
        const faces: number[][] = [
            Array.from({ length: count }, (_, i) => i),
            Array.from({ length: count }, (_, i) => i + count),
        ];
        for (let index = 0; index < count; index++) {
            const next = (index + 1) % count;
            faces.push([index, next, next + count, index + count]);
        }
        this.convex([...front, ...back], faces);
    }

    beam(start: Point, end: Point, width: number): void {
        const direction = unit(subtract(end, start));
        const u = unit(cross(direction, Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const v = cross(direction, u);
        const loop = (point: Point): Point[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
            [point[0] + (u[0] * a! + v[0] * b!) * width / 2,
                point[1] + (u[1] * a! + v[1] * b!) * width / 2,
                point[2] + (u[2] * a! + v[2] * b!) * width / 2]);
        this.prism(loop(start), loop(end));
    }

    finish(): ShipMeshData {
        return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
    }
}

export interface PlayerShipGeometry {
    hull: ShipMeshData;
    cockpit: ShipMeshData;
    wings: readonly [ShipMeshData, ShipMeshData];
    edges: ShipMeshData;
    nozzles: readonly [ShipMeshData, ShipMeshData];
    exhaust: ShipMeshData;
}

/** All static meshes share ship-local coordinates, nose -Z and exhaust +Z. */
export function createPlayerShipGeometry(): PlayerShipGeometry {
    const hull = new MeshBuilder(), cockpit = new MeshBuilder(), edges = new MeshBuilder();
    hull.convex([
        [0, 0.02, -1.05], [-0.27, 0, 0.62], [0.27, 0, 0.62], [0, 0.22, 0.16],
        [0, -0.09, -1.02], [-0.27, -0.14, 0.62], [0.27, -0.14, 0.62],
    ], [
        [0, 3, 1], [0, 2, 3], [1, 3, 2], [0, 4, 5, 1],
        [1, 5, 6, 2], [2, 6, 4, 0], [4, 6, 5],
    ]);
    cockpit.convex([
        [0, 0.115, -0.48], [-0.15, 0.15, -0.08], [0, 0.18, 0.29],
        [0.15, 0.15, -0.08], [0, 0.35, -0.22], [0, 0.32, 0.12],
    ], [[0, 1, 4], [1, 5, 4], [1, 2, 5], [2, 3, 5], [3, 4, 5], [3, 0, 4], [0, 3, 2, 1]]);

    const wings: ShipMeshData[] = [], nozzles: ShipMeshData[] = [];
    for (const side of [-1, 1]) {
        const top: Point[] = [
            [side * 0.1, -0.035, -0.58], [side * 1.04, -0.045, 0.60], [side * 0.25, -0.025, 0.43],
        ];
        hull.prism(top, top.map(([x, y, z]) => [x, y - 0.075, z]));
        const wing = new MeshBuilder();
        const inset: Point[] = [
            [side * 0.25, -0.005, -0.28], [side * 0.86, -0.012, 0.50], [side * 0.34, 0.002, 0.40],
        ];
        wing.prism(inset, inset.map(([x, y, z]) => [x, y - 0.025, z]));
        const fin: Point[] = [
            [side * 0.64, -0.025, 0.34], [side * 0.72, -0.025, 0.56], [side * 0.68, 0.23, 0.50],
        ];
        wing.prism(fin, fin.map(([x, y, z]) => [x + side * 0.035, y, z]));
        wings.push(wing.finish());
        const x = side * 0.34;
        const section: readonly (readonly [number, number])[] = [
            [-0.12, -0.08], [0.12, -0.08], [0.14, 0.015],
            [0.085, 0.13], [-0.085, 0.13], [-0.14, 0.015],
        ];
        hull.prism(section.map(([dx, y]) => [x + dx, y - 0.015, 0.18]),
            section.map(([dx, y]) => [x + dx, y - 0.015, 0.76]));

        const outline: Point[] = [
            [0, 0.035, -1.05], ...top.map<Point>(([px, py, pz]) => [px, py + 0.02, pz]),
        ];
        for (let index = 0; index < outline.length - 1; index++) {
            edges.beam(outline[index]!, outline[index + 1]!, 0.018);
        }
        edges.beam([side * 0.64, -0.01, 0.34], [side * 0.68, 0.24, 0.50], 0.014);

        const nozzle = new MeshBuilder();
        // Eight closed ring wedges make the outlet hollow and visible from behind.
        const ring = (angle: number, radius: number, z: number): Point =>
            [x + Math.cos(angle) * radius, -0.015 + Math.sin(angle) * radius, z];
        for (let index = 0; index < 8; index++) {
            const a = index / 8 * Math.PI * 2, b = (index + 1) / 8 * Math.PI * 2;
            const loop = (z: number) => [ring(a, 0.075, z), ring(a, 0.115, z),
                ring(b, 0.115, z), ring(b, 0.075, z)];
            nozzle.prism(loop(0.77), loop(0.83));
        }
        // A top-facing readiness plate stays legible at every aim angle, even
        // when comfort settings hide the moving exhaust.
        const plate: Point[] = [
            [x - 0.065, 0.126, 0.61], [x + 0.065, 0.126, 0.61],
            [x + 0.065, 0.126, 0.76], [x - 0.065, 0.126, 0.76],
        ];
        nozzle.prism(plate, plate.map(([px, py, pz]) => [px, py - 0.009, pz]));
        nozzles.push(nozzle.finish());
    }
    edges.beam([0, 0.04, -0.97], [0, 0.14, -0.48], 0.02);
    edges.beam([0, 0.36, -0.22], [0, 0.33, 0.12], 0.014);

    const exhaust = new MeshBuilder();
    const exhaustPoints: Point[] = [];
    for (let index = 0; index < 6; index++) {
        const angle = index / 6 * Math.PI * 2;
        exhaustPoints.push([Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, 0]);
    }
    exhaustPoints.push([0, 0, 1]);
    exhaust.convex(exhaustPoints, [
        [0, 1, 2, 3, 4, 5], ...Array.from({ length: 6 }, (_, index) => [index, (index + 1) % 6, 6]),
    ]);
    return {
        hull: hull.finish(), cockpit: cockpit.finish(), wings: wings as [ShipMeshData, ShipMeshData],
        edges: edges.finish(), nozzles: nozzles as [ShipMeshData, ShipMeshData], exhaust: exhaust.finish(),
    };
}
