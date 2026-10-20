type Triple = readonly [number, number, number];

interface Face {
    normal: Triple;
    u: Triple;
    v: Triple;
    uAxis: number;
    vAxis: number;
}

const FACES: readonly Face[] = [
    { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], uAxis: 2, vAxis: 1 },
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], uAxis: 2, vAxis: 1 },
    { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], uAxis: 0, vAxis: 2 },
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], uAxis: 0, vAxis: 2 },
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], uAxis: 0, vAxis: 1 },
    { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], uAxis: 0, vAxis: 1 },
];

/** Unit box with outward CCW faces; full world lengths select approximately half-unit cells. */
export function createSubdividedBox(worldSize: Triple, spacing = 0.5): {
    vertices: Float32Array;
    indices: Uint32Array;
    segments: [number, number, number];
} {
    if (!Number.isFinite(spacing) || spacing <= 0 || worldSize.some(value => !Number.isFinite(value) || value <= 0)) {
        throw new RangeError("Subdivided boxes need positive finite dimensions and spacing.");
    }
    const segments = worldSize.map(value => Math.min(128, Math.max(1, Math.ceil(value / spacing)))) as [number, number, number];
    let vertexCount = 0, indexCount = 0;
    for (const face of FACES) {
        vertexCount += (segments[face.uAxis]! + 1) * (segments[face.vAxis]! + 1);
        indexCount += segments[face.uAxis]! * segments[face.vAxis]! * 6;
    }
    const vertices = new Float32Array(vertexCount * 8), indices = new Uint32Array(indexCount);
    let vertex = 0, index = 0;
    for (const face of FACES) {
        const width = segments[face.uAxis]!, height = segments[face.vAxis]!, first = vertex;
        for (let row = 0; row <= height; row++) {
            const v = row / height;
            for (let column = 0; column <= width; column++) {
                const u = column / width, offset = vertex++ * 8;
                for (let axis = 0; axis < 3; axis++) {
                    vertices[offset + axis] = face.normal[axis]! * 0.5
                        + face.u[axis]! * (u - 0.5) + face.v[axis]! * (v - 0.5);
                    vertices[offset + 4 + axis] = face.normal[axis]!;
                }
                // Shallot's public typed-array staging layout is px,py,pz,u,nx,ny,nz,v.
                vertices[offset + 3] = u;
                vertices[offset + 7] = v;
            }
        }
        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const a = first + row * (width + 1) + column;
                const b = a + 1, d = a + width + 1, c = d + 1;
                indices[index++] = a; indices[index++] = b; indices[index++] = c;
                indices[index++] = a; indices[index++] = c; indices[index++] = d;
            }
        }
    }
    return { vertices, indices, segments };
}

/** Rendering-only sphere padding: never changes the box's Transform or physics Shape. */
export function waveCullBounds(worldSize: Triple, maximumLift = 1.5): [number, number, number, number] {
    return [0, 0, 0, Math.sqrt(3) / 2 + maximumLift / Math.max(...worldSize)];
}
