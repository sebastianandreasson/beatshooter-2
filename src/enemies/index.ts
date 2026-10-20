import type { CombatState, CombatTuning, Vec2 } from "../combat";

/** Physics and projectile masks share these groups. Only group 2 takes player fire. */
export const ENEMY_COLLISION_GROUP = 2;

export interface Enemy {
    id: number;
    x: number;
    z: number;
    radius: number;
    health: number;
    collisionGroup: number;
    spawnBar: number;
    knockbackX: number;
    knockbackZ: number;
    knockbackStartedAt: number;
    knockbackUntil: number;
}

/** Musical bars determine pressure; elapsed render/frame time never increases it. */
export function waveSize(barIndex: number, tuning: CombatTuning): number {
    return Math.min(
        tuning.maxWaveSize,
        tuning.initialWaveSize + Math.floor(Math.max(0, barIndex) / tuning.waveIncreaseEveryBars),
    );
}

/**
 * Spawn on the arena perimeter, using only the supplied RNG. An impossible
 * safety radius means no spawn, never an enemy placed on top of the player.
 */
export function findSpawnPosition(
    player: Vec2,
    tuning: CombatTuning,
    random: () => number,
): Vec2 | undefined {
    const safeSquared = tuning.spawnSafetyRadius ** 2;
    const fits = (point: Vec2) =>
        (point.x - player.x) ** 2 + (point.z - player.z) ** 2 >= safeSquared;
    for (let attempt = 0; attempt < 24; attempt++) {
        const side = Math.floor(random() * 4);
        const edge = tuning.arenaHalfExtent - tuning.spawnInset - random() * tuning.spawnBand;
        const along = (random() * 2 - 1) * edge;
        const point = side === 0 ? { x: -edge, z: along }
            : side === 1 ? { x: edge, z: along }
            : side === 2 ? { x: along, z: -edge }
            : { x: along, z: edge };
        if (fits(point)) return point;
    }
    // A fixed fallback avoids RNG luck suppressing a valid spawn near a corner.
    const edge = tuning.arenaHalfExtent - tuning.spawnInset;
    const corners = [
        { x: -edge, z: -edge }, { x: edge, z: -edge },
        { x: edge, z: edge }, { x: -edge, z: edge },
    ].sort((a, b) =>
        (b.x - player.x) ** 2 + (b.z - player.z) ** 2
        - ((a.x - player.x) ** 2 + (a.z - player.z) ** 2),
    );
    return corners.find(fits);
}

export function createEnemy(id: number, point: Vec2, barIndex: number, tuning: CombatTuning): Enemy {
    return {
        id,
        ...point,
        radius: tuning.enemyRadius,
        health: tuning.enemyHealth,
        collisionGroup: ENEMY_COLLISION_GROUP,
        spawnBar: barIndex,
        knockbackX: 0,
        knockbackZ: 0,
        knockbackStartedAt: 0,
        knockbackUntil: 0,
    };
}

/** Desired planar velocity; the app applies it through Shallot's physics API. */
export function enemyVelocity(enemy: Enemy, player: Vec2, state: CombatState): Vec2 {
    if (enemy.health <= 0 || state.defeated) return { x: 0, z: 0 };
    const dx = player.x - enemy.x;
    const dz = player.z - enemy.z;
    const distance = Math.hypot(dx, dz);
    const speed = Math.min(
        state.tuning.enemyMaxSpeed,
        state.tuning.enemySpeed
            + Math.floor(Math.max(0, state.lastBarIndex) / state.tuning.speedIncreaseEveryBars)
                * state.tuning.enemySpeedIncrease,
    );
    const knockback = state.time < enemy.knockbackUntil
        ? Math.exp(-state.tuning.knockbackDecay * Math.max(0, state.time - enemy.knockbackStartedAt))
        : 0;
    return {
        x: (distance > 0.00001 ? dx / distance * speed : 0) + enemy.knockbackX * knockback,
        z: (distance > 0.00001 ? dz / distance * speed : 0) + enemy.knockbackZ * knockback,
    };
}
