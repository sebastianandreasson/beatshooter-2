export const STAR_COUNT = 240;
export const LOW_DETAIL_STAR_COUNT = 120;
const VIEW_LENGTH = Math.hypot(32, 19);
const UP_Y = 19 / VIEW_LENGTH;
const UP_Z = -32 / VIEW_LENGTH;
const BACK_Y = 32 / VIEW_LENGTH;
const BACK_Z = 19 / VIEW_LENGTH;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
    const p = clamp01(value);
    return p * p * (3 - 2 * p);
};

export interface StarSeed {
    layer: number;
    phase: number;
    angle: number;
    x: number;
    y: number;
    size: number;
    rate: number;
    depth: number;
}

export interface StarPose {
    x: number;
    y: number;
    z: number;
    width: number;
    length: number;
}

/** Fixed stars with independent phases, sizes and speeds; retries reuse the same field. */
export function createStarSeeds(count = STAR_COUNT): StarSeed[] {
    let randomState = 0x57a2f13d;
    const random = () => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 0x1_0000_0000;
    };
    return Array.from({ length: count }, (_, index) => {
        const layer = index % 3;
        const angle = random() * Math.PI * 2;
        return {
            layer, phase: random(), angle, x: Math.cos(angle), y: Math.sin(angle),
            size: 0.7 + random() * 0.85,
            rate: 0.018 * [0.65, 0.95, 1.35][layer]!,
            depth: 96 - layer * 16,
        };
    });
}

/**
 * Absolute integrated song distance drives each star through a distant view-facing
 * plane. Width fades to zero before recycling, and boost stretches a trailing streak.
 * Reusing `out` avoids allocating during presentation.
 */
export function sampleStarPose(seed: StarSeed, distance: number, boost: number, out: StarPose): StarPose {
    const phase = ((seed.phase + Math.max(0, distance) * seed.rate) % 1 + 1) % 1;
    const fade = smooth(phase / 0.055) * (1 - smooth((phase - 0.9) / 0.1));
    const width = (0.064 + seed.layer * 0.008) * seed.size * fade;
    const length = width + clamp01(boost) * (2.5 + seed.layer * 1.2) * fade;
    // The head follows a constant radial velocity; extra length trails behind it.
    const radius = 3 + phase * 45 - (length - width) * 0.5;
    const screenX = seed.x * radius, screenY = seed.y * radius;
    out.x = screenX;
    out.y = screenY * UP_Y - seed.depth * BACK_Y;
    out.z = screenY * UP_Z - seed.depth * BACK_Z;
    out.width = width;
    out.length = length;
    return out;
}
