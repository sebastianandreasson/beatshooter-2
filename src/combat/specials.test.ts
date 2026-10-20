import { expect, test } from "bun:test";
import { advanceCombat, createCombat, fireEnemyProjectile, fireProjectile, onCombatBeat } from "./index";
import { createEnemy } from "../enemies";
import { setPlayerStatModifier } from "../player-stats";
import { firstWallHit, HOMING_TURN_BUDGET, HOMING_TURN_RATE, shieldReady, steerProjectile } from "./specials";

const origin = { x: 0, z: 0 };
const away = { x: -10, z: -10 };
const still = { enemySpeed: 0, enemyMaxSpeed: 0, knockbackSpeed: 0, contactDamage: 0 };

test("wall shots reflect off all four walls, retain damage and speed, then retire at the next wall", () => {
    for (const direction of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
        const state = createCombat(1, still, { wallBounces: 1, bounces: 3 });
        const shot = fireProjectile(state, origin, direction)!;
        const damage = shot.damage;
        advanceCombat(state, 0.6, away);
        expect(state.projectiles).toHaveLength(1);
        expect(shot.wallBouncesRemaining).toBe(0);
        expect(shot.velocityX).toBeCloseTo(-direction.x * 32);
        expect(shot.velocityZ).toBeCloseTo(-direction.z * 32);
        expect(shot.damage).toBe(damage);
        expect(shot.bouncesRemaining).toBe(3);
        expect(shot.waitingForBounce).toBe(false);
        expect(Math.max(Math.abs(shot.x), Math.abs(shot.z))).toBeCloseTo(15.81);
        advanceCombat(state, 2, away);
        expect(state.projectiles).toHaveLength(0);
    }
});

test("corner impact is one rebound on both axes and the leftover sweep catches an enemy", () => {
    expect(firstWallHit(origin, { x: 20, z: 20 }, 18)).toEqual({
        fraction: 0.9, reflectX: true, reflectZ: true,
    });
    const state = createCombat(1, still, { wallBounces: 1 });
    const shot = fireProjectile(state, origin, { x: 1, z: 1 })!;
    advanceCombat(state, 0.8, away);
    expect(shot.velocityX).toBeLessThan(0);
    expect(shot.velocityZ).toBeLessThan(0);
    expect(shot.wallBouncesRemaining).toBe(0);
    const enemy = createEnemy(99, { x: 14, z: 14 }, 0, state.tuning);
    state.enemies.push(enemy);
    advanceCombat(state, 0.2, away);
    expect(enemy.health).toBe(Math.max(0, 24 - shot.damage));
    expect(state.projectiles).toHaveLength(0);
});

test("wall reflection sweeps both legs, cannot hit through walls, and preserves enemy ricochet rules", () => {
    const state = createCombat(1, still, { wallBounces: 1, bounces: 1 });
    const shot = fireProjectile(state, { x: 16, z: 0 }, { x: 1, z: 0 })!;
    const behind = createEnemy(90, { x: 14, z: 0 }, 0, state.tuning);
    const outside = createEnemy(91, { x: 19, z: 0 }, 0, state.tuning);
    state.enemies.push(outside, behind);
    advanceCombat(state, 0.2, away, new Map(state.enemies.map(enemy => [enemy.id, { x: enemy.x, z: enemy.z }])));
    expect(outside.health).toBe(24);
    expect(behind.health).toBe(Math.max(0, 24 - shot.damage));
    expect(shot.wallBouncesRemaining).toBe(0);
    expect(shot.waitingForBounce).toBe(true);
    state.enemies = [behind, createEnemy(92, { x: 10, z: 1 }, 0, state.tuning)];
    onCombatBeat(state, { index: 1, barIndex: 0, time: 0.5 }, away, origin);
    expect(shot.damage).toBe(Math.round(shot.initialDamage * 0.7));
    expect(shot.wallBouncesRemaining).toBe(0);
    expect(shot.waitingForBounce).toBe(false);
});

test("enemy impact before the wall wins and a normal or hostile shot cannot wall-bounce", () => {
    for (const wallBounces of [0, 1]) {
        const state = createCombat(1, still, { wallBounces });
        const enemy = createEnemy(90, { x: 16, z: 0 }, 0, state.tuning);
        state.enemies.push(enemy);
        const shot = fireProjectile(state, origin, { x: 1, z: 0 })!;
        advanceCombat(state, 0.6, away);
        expect(enemy.health).toBe(Math.max(0, 24 - shot.damage));
        expect(state.projectiles).toHaveLength(0);
    }
    const state = createCombat(1, still, { wallBounces: 1, homing: 1 });
    const shooter = createEnemy(90, { x: 17, z: 0 }, 0, state.tuning);
    const shot = fireEnemyProjectile(state, shooter, { x: 1, z: 0 })!;
    expect(shot.wallBouncesRemaining).toBe(0);
    expect(shot.homingTurnRemaining).toBe(0);
    advanceCombat(state, 0.2, away);
    expect(state.projectiles).toHaveLength(0);
});

test("homing bends toward the nearest eligible enemy without changing speed or exceeding either cap", () => {
    const state = createCombat(1, still, { homing: 1 });
    const shot = fireProjectile(state, origin, { x: 1, z: 0 })!;
    state.enemies.push(
        createEnemy(80, { x: -2, z: -1 }, 0, state.tuning), // Behind.
        createEnemy(81, { x: 8, z: -4 }, 0, state.tuning),
        createEnemy(82, { x: 6, z: 4 }, 0, state.tuning), // Nearest ahead.
    );
    steerProjectile(shot, state, 1 / 60);
    expect(Math.atan2(shot.velocityZ, shot.velocityX)).toBeCloseTo(HOMING_TURN_RATE / 60);
    expect(Math.hypot(shot.velocityX, shot.velocityZ)).toBeCloseTo(32);
    for (let i = 0; i < 200; i++) steerProjectile(shot, state, 1 / 60);
    expect(Math.atan2(shot.velocityZ, shot.velocityX)).toBeCloseTo(HOMING_TURN_BUDGET);
    expect(shot.homingTurnRemaining).toBe(0);
    const velocity = [shot.velocityX, shot.velocityZ];
    steerProjectile(shot, state, 100);
    expect([shot.velocityX, shot.velocityZ]).toEqual(velocity);
});

test("homing ignores dead, previously hit, friendly, distant targets and waiting ricochets", () => {
    const state = createCombat(1, still, { homing: 1 });
    const shot = fireProjectile(state, origin, { x: 1, z: 0 })!;
    const enemies = [2, 3, 4, 5].map(id => createEnemy(id, { x: id, z: 1 }, 0, state.tuning));
    enemies[0]!.health = 0;
    shot.hitEnemyIds = [3];
    enemies[2]!.collisionGroup = 1;
    enemies[3]!.x = 100;
    state.enemies = enemies;
    steerProjectile(shot, state, 1);
    expect(shot.velocityZ).toBe(0);
    state.enemies.push(createEnemy(9, { x: 6, z: 3 }, 0, state.tuning));
    shot.waitingForBounce = true;
    steerProjectile(shot, state, 1);
    expect(shot.velocityZ).toBe(0);
});

test("special weapon upgrades snapshot at firing, apply to new shots and do not modify hostile fire", () => {
    const state = createCombat(1, still);
    const old = fireProjectile(state, origin, { x: 1, z: 0 })!;
    setPlayerStatModifier(state.playerStats, "specials", { add: { wallBounces: 10, homing: 10 } });
    const fresh = fireProjectile(state, origin, { x: 1, z: 0 })!;
    expect(old.wallBouncesRemaining).toBe(0);
    expect(old.homingTurnRemaining).toBe(0);
    expect(fresh.wallBouncesRemaining).toBe(1);
    expect(fresh.homingTurnRemaining).toBe(HOMING_TURN_BUDGET);
});

test("shield blocks one contact hit, shares immunity, recharges at 25 song seconds, and resets", () => {
    const state = createCombat(1, { ...still, contactDamage: 15 }, { regenerativeShield: 1 });
    state.enemies.push(createEnemy(2, origin, 0, state.tuning));
    expect(shieldReady(state, 0)).toBe(true);
    const blocked = advanceCombat(state, 0.1, origin, undefined, origin, 10);
    expect(blocked.playerDamaged).toBe(false);
    expect(state.health).toBe(100);
    expect(state.shieldBlocks).toBe(1);
    expect(state.shieldRechargeAt).toBe(35);
    expect(shieldReady(state, 34.999)).toBe(false);
    // Held song time / no beat still cannot recharge, even as fixed ticks run.
    for (let i = 0; i < 10; i++) advanceCombat(state, 0.1, away, undefined, away, 10);
    expect(shieldReady(state, 10)).toBe(false);
    advanceCombat(state, 0.1, origin, undefined, origin, 34.999);
    expect(state.health).toBe(85);
    advanceCombat(state, 1, away, undefined, away, 35);
    expect(shieldReady(state, 35)).toBe(true);
    advanceCombat(state, 0.1, origin, undefined, origin, 35.1);
    expect(state.health).toBe(85);
    expect(state.shieldBlocks).toBe(2);
    expect(state.shieldRechargeAt).toBe(60.1);
    expect(shieldReady(createCombat(), 100)).toBe(false);
});

test("shield absorbs hostile fire without a damage event; simultaneous hits cannot drain hull", () => {
    const state = createCombat(1, still, { regenerativeShield: 1 });
    const shooter = createEnemy(2, { x: 2, z: 0 }, 0, state.tuning);
    fireEnemyProjectile(state, shooter, { x: -1, z: 0 });
    fireEnemyProjectile(state, shooter, { x: -1, z: 0 });
    const result = advanceCombat(state, 0.2, origin, undefined, origin, 4);
    expect(state.health).toBe(100);
    expect(state.shieldBlocks).toBe(1);
    expect(state.projectiles).toHaveLength(0);
    expect(result.events.some(event => event.kind === "player-hit")).toBe(false);
    expect(state.shieldRechargeAt).toBe(29);
    expect(state.playerStats.metrics.hits).toBe(0);
});
