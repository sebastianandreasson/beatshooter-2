export interface Planar { x: number; z: number }
export const PLAYER_SPEED = 8;

/** Exponential acceleration/damping is independent of the display's frame rate. */
export function movementVelocity(current: Planar, input: Planar, dt: number): Planar {
    const length = Math.hypot(input.x, input.z);
    const scale = length > 1 ? 1 / length : 1;
    const blend = 1 - Math.exp(-(length ? 18 : 24) * dt);
    return {
        x: current.x + (input.x * scale * PLAYER_SPEED - current.x) * blend,
        z: current.z + (input.z * scale * PLAYER_SPEED - current.z) * blend,
    };
}

export function planeIntersection(origin: readonly number[], direction: readonly number[], height = 0.55): Planar | null {
    if (Math.abs(direction[1]!) < 1e-6) return null;
    const distance = (height - origin[1]!) / direction[1]!;
    if (distance < 0 || !Number.isFinite(distance)) return null;
    return { x: origin[0]! + direction[0]! * distance, z: origin[2]! + direction[2]! * distance };
}

export function aimDirection(player: Planar, target: Planar, last: Planar): Planar {
    const x = target.x - player.x, z = target.z - player.z;
    const length = Math.hypot(x, z);
    return length < 1e-6 ? last : { x: x / length, z: z / length };
}
