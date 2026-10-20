import type { CombatState, CombatTuning, Vec2 } from "../combat";
import { enemyStrideGain } from "./movement";

/** Physics and projectile masks share these groups. Only group 2 takes player fire. */
export const ENEMY_COLLISION_GROUP = 2;

export type EnemyKind = "chaser" | "spinner" | "ranger";

export interface Enemy {
    id: number;
    kind: EnemyKind;
    /** Planar heading: forward is { x: sin(heading), z: cos(heading) }. */
    heading: number;
    x: number;
    z: number;
    radius: number;
    health: number;
    /** Unscaled capacity, retained to avoid rounding drift across sections. */
    baseHealth: number;
    /** Current section-scaled capacity; damage only changes health. */
    maxHealth: number;
    collisionGroup: number;
    spawnBar: number;
    knockbackX: number;
    knockbackZ: number;
    knockbackStartedAt: number;
    knockbackUntil: number;
}

/** Introduce both ranged enemies in the first three bars, then repeat the mix. */
export function enemyKindForSpawn(barIndex: number, slot: number): EnemyKind {
    const kinds = ["chaser", "spinner", "ranger"] as const;
    return kinds[(Math.max(0, Math.floor(barIndex)) + Math.max(0, Math.floor(slot))) % kinds.length]!;
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
    return safeCorner(player, tuning.arenaHalfExtent - tuning.spawnInset, safeSquared);
}

/**
 * Stationary shooters can occupy the arena interior, while keeping the same
 * player safety margin and bounded, seeded sampling as perimeter waves.
 */
export function findArenaSpawnPosition(
    player: Vec2,
    tuning: CombatTuning,
    random: () => number,
): Vec2 | undefined {
    const edge = tuning.arenaHalfExtent - tuning.spawnInset;
    const safeSquared = tuning.spawnSafetyRadius ** 2;
    for (let attempt = 0; attempt < 24; attempt++) {
        const point = { x: (random() * 2 - 1) * edge, z: (random() * 2 - 1) * edge };
        if ((point.x - player.x) ** 2 + (point.z - player.z) ** 2 >= safeSquared) {
            return point;
        }
    }
    return safeCorner(player, edge, safeSquared);
}

/** A fixed fallback avoids RNG luck suppressing a valid spawn near a corner. */
function safeCorner(player: Vec2, edge: number, safeSquared: number): Vec2 | undefined {
    const corners = [
        { x: -edge, z: -edge }, { x: edge, z: -edge },
        { x: edge, z: edge }, { x: -edge, z: edge },
    ].sort((a, b) =>
        (b.x - player.x) ** 2 + (b.z - player.z) ** 2
        - ((a.x - player.x) ** 2 + (a.z - player.z) ** 2),
    );
    return corners.find((point) =>
        (point.x - player.x) ** 2 + (point.z - player.z) ** 2 >= safeSquared,
    );
}

export function createEnemy(
    id: number,
    point: Vec2,
    barIndex: number,
    tuning: CombatTuning,
    kind: EnemyKind = "chaser",
    heading = 0,
): Enemy {
    return {
        id,
        kind,
        heading,
        ...point,
        radius: tuning.enemyRadius,
        health: tuning.enemyHealth,
        baseHealth: tuning.enemyHealth,
        maxHealth: tuning.enemyHealth,
        collisionGroup: ENEMY_COLLISION_GROUP,
        spawnBar: barIndex,
        knockbackX: 0,
        knockbackZ: 0,
        knockbackStartedAt: 0,
        knockbackUntil: 0,
    };
}

/** Desired planar velocity; the app applies it through Shallot's physics API. */
export function enemyVelocity(
    enemy: Enemy, player: Vec2, state: CombatState, musicPosition = state.time, dt = 0,
    previousMusicPosition = musicPosition - dt,
): Vec2 {
    if (enemy.health <= 0 || state.defeated) return { x: 0, z: 0 };
    // Marksmen commit both muzzle and aim for their visible warning interval.
    if (state.encounter?.rangerWarnings.has(enemy.id)) return { x: 0, z: 0 };
    const dx = player.x - enemy.x;
    const dz = player.z - enemy.z;
    const distance = Math.hypot(dx, dz);
    const speed = state.encounter?.enemySpeed ?? Math.min(
        state.tuning.enemyMaxSpeed,
        state.tuning.enemySpeed
            + Math.floor(Math.max(0, state.lastBarIndex) / state.tuning.speedIncreaseEveryBars)
                * state.tuning.enemySpeedIncrease,
    );
    const knockback = state.time < enemy.knockbackUntil
        ? Math.exp(-state.tuning.knockbackDecay * Math.max(0, state.time - enemy.knockbackStartedAt))
        : 0;
    const strideSpeed = speed * enemyStrideGain(state.movementBeat, musicPosition, dt, previousMusicPosition);
    // Pursuit rests between beats. Knockback still confirms a hit immediately.
    // Rangers ease into firing distance; spinners remain stationary shooters.
    const approachSpeed = enemy.kind === "spinner" ? 0
        : enemy.kind === "ranger"
        ? Math.min(strideSpeed, Math.max(0, distance - state.tuning.rangerStopDistance) * 4)
        : Math.min(strideSpeed, dt > 0 ? distance / dt : Infinity);
    return {
        x: (distance > 0.00001 ? dx / distance * approachSpeed : 0) + enemy.knockbackX * knockback,
        z: (distance > 0.00001 ? dz / distance * approachSpeed : 0) + enemy.knockbackZ * knockback,
    };
}
