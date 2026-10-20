export interface SpawnComfort {
    motionAllowed: boolean;
    intensity: number;
}

export interface EnemySpawnPose {
    progress: number;
    scale: number;
    y: number;
    yaw: number;
    beamBottom: number;
    beamTop: number;
    beamWidth: number;
    beamCoreWidth: number;
    outlineRadius: number;
    outlineWidth: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
    const p = clamp(value);
    return p * p * (3 - 2 * p);
};

/**
 * The two timestamps are adjacent authored beats. No frame delta, calibrated
 * visual offset, or free-running tween can move this spawn ahead of activation.
 */
export function enemySpawnPose(
    startTime: number,
    endTime: number,
    position: number,
    comfort: SpawnComfort,
): EnemySpawnPose {
    const duration = endTime - startTime;
    const progress = duration > 0 ? clamp((position - startTime) / duration)
        : position >= endTime ? 1 : 0;
    const growth = smooth(progress);
    const motion = comfort.motionAllowed;
    const strength = clamp(comfort.intensity / 0.85);
    const remaining = 1 - progress;
    const travel = motion ? 0.45 + 1.65 * strength : 0;
    const spin = motion ? (0.2 + 0.8 * strength) * Math.PI * 2 : 0;
    const top = 0.7 + (1.5 + 2 * strength) * (1 - smooth((progress - 0.5) / 0.5));
    // A narrow column reaches down first, then recedes as the body assembles.
    const bottom = Math.min(top, 0.06 + (top - 0.06) * (1 - smooth(progress / 0.22)));
    const beamEnvelope = smooth(progress / 0.12) * (1 - smooth((progress - 0.62) / 0.38));
    return {
        progress,
        scale: growth,
        y: 0.55 + travel * remaining ** 2,
        yaw: Math.PI / 4 + spin * remaining ** 2,
        beamBottom: bottom,
        beamTop: top,
        beamWidth: motion ? (0.018 + strength * 0.014) * beamEnvelope : 0,
        beamCoreWidth: motion ? (1 + strength * 0.2) * beamEnvelope : 0,
        // The floor marker remains useful when optional decoration is disabled.
        outlineRadius: 0.78 + (motion ? 0.2 * (1 - growth) * strength : 0),
        outlineWidth: 0.035 * (1 - smooth((progress - 0.8) / 0.2)),
    };
}
