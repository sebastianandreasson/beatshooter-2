import type { CombatState, Projectile, Vec2 } from "./index";
import { recordPlayerShot } from "../player-stats";

export const EXPLOSION_BASE_RADIUS = 2.5;
export const EXPLOSION_VISUAL_SECONDS = 0.35;
export const FORK_RANGE = 8;
export const FORK_DAMAGE_MULTIPLIER = 0.2;

export interface EnemyExplosion extends Vec2 {
    id: number;
    damage: number;
    sourceDamage: number;
    radius: number;
    bornAt: number;
}

export interface AfterImage extends Vec2 {
    id: number;
    aim: Vec2;
    startedAt: number;
    expiresAt: number;
}

/** Only accepted dashes call this. Lifetimes use the chart's next bar boundary. */
export function leaveAfterImage(state: CombatState, origin: Vec2, aim: Vec2, startedAt: number, expiresAt: number): void {
    if (state.defeated || state.playerStats.effective.afterImage === 0 || expiresAt <= startedAt) return;
    state.afterImage = { id: state.nextId++, ...origin, aim: { ...aim }, startedAt, expiresAt };
}

/** Mirror the successfully fired volley exactly, without rerolling damage or crits. */
export function mirrorShots(state: CombatState, shots: readonly Projectile[], player: Vec2, aim: Vec2, songTime: number): Projectile[] {
    const clone = state.afterImage;
    if (!clone) return [];
    if (songTime >= clone.expiresAt) { state.afterImage = undefined; return []; }
    if (songTime < clone.startedAt) return [];
    clone.aim = { ...aim };
    const mirrored: Projectile[] = [];
    for (const shot of shots) {
        if (state.projectiles.length >= state.tuning.projectileCap) break;
        const x = clone.x + shot.x - player.x, z = clone.z + shot.z - player.z;
        const copy: Projectile = { ...shot, id: state.nextId++, x, z, previousX: x, previousZ: z,
            hitEnemyIds: [], fromAfterImage: true };
        state.projectiles.push(copy);
        recordPlayerShot(state.playerStats);
        mirrored.push(copy);
    }
    return mirrored;
}

/** Children start at impact, ignore that enemy and cannot recurse or extend their range. */
export function forkShots(state: CombatState, parent: Projectile, impact: Vec2, enemyId: number, slots: number): Projectile[] {
    if (!parent.forksOnHit || parent.hitEnemyIds.length > 0 || slots < 1) return [];
    const angle = Math.atan2(parent.velocityZ, parent.velocityX);
    const speed = Math.hypot(parent.velocityX, parent.velocityZ);
    if (speed <= 0) return [];
    return [-Math.PI / 6, Math.PI / 6].slice(0, slots).map(offset => {
        const damage = Math.round(parent.initialDamage * FORK_DAMAGE_MULTIPLIER);
        recordPlayerShot(state.playerStats);
        return { ...parent, id: state.nextId++, ...impact, previousX: impact.x, previousZ: impact.z,
            velocityX: Math.cos(angle + offset) * speed, velocityZ: Math.sin(angle + offset) * speed,
            damage, initialDamage: damage, radius: parent.radius * 0.55,
            remainingLifetime: FORK_RANGE / speed, wallBouncesRemaining: 0, homingTurnRemaining: 0,
            bouncesRemaining: 0, hitEnemyIds: [enemyId], waitingForBounce: false,
            forksOnHit: false, forked: true };
    });
}
