import type { CombatState, Projectile, Vec2 } from "./index";

export const SHIELD_RECHARGE_SECONDS = 25;
export const HOMING_TURN_RATE = Math.PI / 6; // 30 degrees per second.
export const HOMING_TURN_BUDGET = Math.PI / 6; // At most 30 degrees over the entire flight.
export const HOMING_RANGE = 14;

export function shieldReady(state: CombatState, songPosition: number): boolean {
    return state.playerStats.effective.regenerativeShield > 0 && songPosition >= state.shieldRechargeAt;
}

/** Capture enough travel for one arena crossing, including the bounded homing curve. */
export function wallFlightLifetime(state: CombatState): number {
    return Math.max(state.tuning.projectileLifetime,
        (2 * state.tuning.arenaHalfExtent * Math.SQRT2 + 2)
        / Math.max(0.001, state.tuning.projectileSpeed) / Math.cos(HOMING_TURN_BUDGET));
}

/** A small steering correction, never a snap, U-turn, speed change or new target hit. */
export function steerProjectile(shot: Projectile, state: CombatState, dt: number): void {
    if (shot.homingTurnRemaining <= 0 || shot.waitingForBounce) return;
    const speed = Math.hypot(shot.velocityX, shot.velocityZ);
    if (speed <= 0) return;
    let target: Vec2 | undefined, targetId = Infinity, distance = HOMING_RANGE ** 2;
    for (const enemy of state.enemies) {
        if (enemy.health <= 0 || enemy.id === shot.shooterId || shot.hitEnemyIds.includes(enemy.id)
            || !(enemy.collisionGroup & shot.collisionMask)) continue;
        const dx = enemy.x - shot.x, dz = enemy.z - shot.z;
        const squared = dx * dx + dz * dz;
        // Acquire only ahead of the shot; a target behind cannot pull it back.
        if (dx * shot.velocityX + dz * shot.velocityZ <= 0) continue;
        if (squared < distance || (squared === distance && enemy.id < targetId)) {
            target = enemy; targetId = enemy.id; distance = squared;
        }
    }
    if (!target) return;
    const current = Math.atan2(shot.velocityZ, shot.velocityX);
    const desired = Math.atan2(target.z - shot.z, target.x - shot.x);
    const difference = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
    const turn = Math.sign(difference) * Math.min(Math.abs(difference), HOMING_TURN_RATE * dt, shot.homingTurnRemaining);
    shot.velocityX = Math.cos(current + turn) * speed;
    shot.velocityZ = Math.sin(current + turn) * speed;
    shot.homingTurnRemaining = Math.max(0, shot.homingTurnRemaining - Math.abs(turn));
}

/** First physical wall on a swept segment. A corner reflects both axes as one impact. */
export function firstWallHit(start: Vec2, end: Vec2, limit: number):
    { fraction: number; reflectX: boolean; reflectZ: boolean } | undefined {
    const dx = end.x - start.x, dz = end.z - start.z;
    const tx = dx > 0 ? (limit - start.x) / dx : dx < 0 ? (-limit - start.x) / dx : Infinity;
    const tz = dz > 0 ? (limit - start.z) / dz : dz < 0 ? (-limit - start.z) / dz : Infinity;
    const fraction = Math.max(0, Math.min(tx, tz));
    if (fraction > 1) return;
    return { fraction, reflectX: tx <= tz + 1e-9, reflectZ: tz <= tx + 1e-9 };
}
