export const TRAIL_CAPACITY = 192;
export const LOW_TRAIL_CAPACITY = 64;

export interface TrailPose {
    x: number; y: number; z: number;
    width: number; length: number; yaw: number;
}

/** A short fraction of the actual local beat, sampled from absolute song age. */
export function sampleTrailPose(
    x: number, z: number, velocityX: number, velocityZ: number,
    age: number, beatDuration: number, hostile: boolean, calm: boolean, out: TrailPose,
): TrailPose {
    const speed = Math.hypot(velocityX, velocityZ);
    const beat = Number.isFinite(beatDuration) && beatDuration > 0 ? Math.min(3.05, beatDuration) : 0.5;
    const duration = beat * (hostile ? 0.14 : 0.12) * (calm ? 0.65 : 1);
    const gap = hostile ? 0.11 : 0.23;
    const cap = (hostile ? 1.2 : 2) * (calm ? 0.55 : 1);
    const valid = [x, z, velocityX, velocityZ, age].every(Number.isFinite) && age >= 0 && speed > 0.0001;
    const length = valid ? Math.min(cap, Math.max(0, speed * Math.min(age, duration) - gap)) : 0;
    const directionX = valid ? velocityX / speed : 0, directionZ = valid ? velocityZ / speed : 0;
    out.x = Number.isFinite(x) ? x - directionX * (gap + length / 2) : 0;
    out.y = 0.55;
    out.z = Number.isFinite(z) ? z - directionZ * (gap + length / 2) : 0;
    out.width = (hostile ? 0.085 : 0.065) * (calm ? 0.75 : 1);
    out.length = length;
    out.yaw = valid ? Math.atan2(velocityX, velocityZ) : 0;
    return out;
}

/** One closed, tapered mesh per trail; the tip fades by narrowing to a fine point. */
export function trailGeometry(): { vertices: Float32Array; indices: Uint32Array } {
    const points = [
        [-0.04, -0.04, -0.5], [0.04, -0.04, -0.5], [0.04, 0.04, -0.5], [-0.04, 0.04, -0.5],
        [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
    ];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2]];
    const vertices: number[] = [], indices: number[] = [];
    for (const face of faces) {
        const a = points[face[0]!]!, b = points[face[1]!]!, c = points[face[2]!]!;
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const length = Math.hypot(...n), first = vertices.length / 8;
        for (let corner = 0; corner < 4; corner++) {
            const p = points[face[corner]!]!;
            vertices.push(p[0]!, p[1]!, p[2]!, corner === 1 || corner === 2 ? 1 : 0,
                n[0]! / length, n[1]! / length, n[2]! / length, corner >= 2 ? 1 : 0);
        }
        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
