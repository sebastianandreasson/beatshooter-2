import { describe, expect, test } from "bun:test";
import { createEnemy, enemyVelocity } from "../enemies";
import {
    advanceCombat, createCombat, fireProjectile, onCombatBeat, segmentCircleHit,
    spawnOnBeat, type CombatState, type Vec2,
} from "./index";

const origin = { x: 0, z: 0 };
const right = { x: 1, z: 0 };

function target(state: CombatState, x: number, z = 0) {
    const enemy = createEnemy(state.nextId++, { x, z }, 0, state.tuning);
    state.enemies.push(enemy);
    return enemy;
}

function freezePositions(state: CombatState): ReadonlyMap<number, Vec2> {
    return new Map(state.enemies.map((enemy) => [enemy.id, { x: enemy.x, z: enemy.z }]));
}

describe("swept projectile collision", () => {
    test("a fast shot hits a target between its endpoints", () => {
        const state = createCombat(11, { damageMin: 10, damageMax: 10, criticalChance: 0 });
        const enemy = target(state, 7);
        fireProjectile(state, origin, right);
        advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(enemy.health).toBe(14);
        expect(state.projectiles).toHaveLength(0);
        expect(state.effects).toHaveLength(1);
        advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(enemy.health).toBe(14);
    });

    test("only the nearest eligible target takes damage, regardless of array order", () => {
        const state = createCombat(2, { damageMin: 10, damageMax: 10, criticalChance: 0 });
        const far = target(state, 9);
        const near = target(state, 4);
        fireProjectile(state, origin, right);
        advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(near.health).toBe(14);
        expect(far.health).toBe(24);
    });

    test("the collision mask ignores friendly entities and the shooter", () => {
        const state = createCombat(2, { damageMin: 10, damageMax: 10, criticalChance: 0 });
        const friendly = target(state, 3);
        friendly.collisionGroup = 1;
        const shooter = target(state, 5);
        const hostile = target(state, 8);
        fireProjectile(state, origin, right, shooter.id);
        advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(friendly.health).toBe(24);
        expect(shooter.health).toBe(24);
        expect(hostile.health).toBe(14);
    });

    test("thickness catches a grazing hit, and a zero-length segment works inside a target", () => {
        expect(segmentCircleHit(origin, { x: 10, z: 0 }, { x: 5, z: 0.6 }, 0.7))
            .toBeCloseTo(0.463944, 5);
        expect(segmentCircleHit(origin, origin, origin, 0.7)).toBe(0);
        expect(segmentCircleHit(origin, origin, { x: 5, z: 0 }, 0.7)).toBeUndefined();
        expect(segmentCircleHit(origin, { x: 10, z: 0 }, { x: 5, z: 1 }, 0.7))
            .toBeUndefined();
    });

    test("a projectile cannot hit beyond its remaining lifetime", () => {
        const state = createCombat(2, { projectileLifetime: 0.05, projectileSpeed: 10 });
        const enemy = target(state, 8);
        fireProjectile(state, origin, right);
        advanceCombat(state, 1, origin, freezePositions(state));
        expect(enemy.health).toBe(24);
        expect(state.projectiles).toHaveLength(0);
    });

    test("dead targets cannot absorb another projectile and kills score only once", () => {
        const state = createCombat(2, { damageMin: 30, damageMax: 30, criticalChance: 0 });
        const near = target(state, 4);
        const far = target(state, 8);
        fireProjectile(state, origin, right);
        fireProjectile(state, origin, right);
        const result = advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(result.killedIds).toEqual([near.id, far.id]);
        expect(state.enemies).toHaveLength(0);
        expect(state.kills).toBe(2);
        expect(state.score).toBe(200);
        expect(state.projectiles).toHaveLength(0);
    });
});

describe("damage, feedback, and defeat", () => {
    test("step events retain every impact even when the legacy feedback buffer is disabled", () => {
        const state = createCombat(2, { effectCap: 0, damageMin: 30, damageMax: 30, criticalChance: 0 });
        target(state, 4);
        target(state, 8);
        fireProjectile(state, origin, right);
        fireProjectile(state, origin, right);
        const result = advanceCombat(state, 0.5, origin, freezePositions(state));
        expect(state.effects).toHaveLength(0);
        expect(result.events.map(event => [event.kind, event.x, event.simulationTime])).toEqual([
            ["kill", 4, 0.5], ["kill", 8, 0.5],
        ]);
        expect(new Set(result.events.map(event => event.id)).size).toBe(2);
        expect(state.kills).toBe(2);
        expect(advanceCombat(state, 1 / 60, origin).events).toHaveLength(0);
    });

    test("critical damage, knockback, and feedback have bounded lifetimes", () => {
        const state = createCombat(1, {
            damageMin: 5, damageMax: 5, criticalChance: 1, criticalMultiplier: 2,
        });
        const enemy = target(state, 4);
        fireProjectile(state, origin, right);
        advanceCombat(state, 0.2, origin, freezePositions(state));
        expect(enemy.health).toBe(14);
        expect(state.effects[0]?.critical).toBe(true);
        expect(state.effects[0]?.amount).toBe(10);
        expect(enemyVelocity(enemy, origin, state).x).toBeGreaterThan(0);
        advanceCombat(state, 1, origin, freezePositions(state));
        expect(state.effects).toHaveLength(0);
        expect(enemyVelocity(enemy, origin, state).x).toBeLessThan(0);
    });

    test("overlapping enemies cause only one contact hit per invulnerability window", () => {
        const state = createCombat(1);
        target(state, 1.2);
        target(state, -1.2);
        const positions = freezePositions(state);
        advanceCombat(state, 0.01, origin, positions);
        expect(state.health).toBe(85);
        advanceCombat(state, 0.5, origin, positions);
        expect(state.health).toBe(85);
        advanceCombat(state, 0.5, origin, positions);
        expect(state.health).toBe(70);
    });

    test("defeat is terminal until the owner creates a new session", () => {
        const state = createCombat(1, { playerHealth: 15 });
        target(state, 1.2);
        const result = advanceCombat(state, 0.01, origin, freezePositions(state));
        expect(result.defeated).toBe(true);
        expect(state.health).toBe(0);
        const snapshot = structuredClone(state);
        onCombatBeat(state, { index: 0, barIndex: 0 }, origin, right);
        advanceCombat(state, 1, origin);
        expect(state).toEqual(snapshot);
        expect(createCombat(1).health).toBe(100);
    });

    test("invalid steps cannot corrupt state and a stationary aim keeps the last aim", () => {
        const state = createCombat(1);
        fireProjectile(state, origin, right);
        const last = fireProjectile(state, origin, origin)!;
        expect(last.velocityX).toBe(32);
        expect(last.velocityZ).toBe(0);
        const snapshot = structuredClone(state);
        advanceCombat(state, NaN, origin);
        advanceCombat(state, -1, origin);
        advanceCombat(state, 0, origin);
        expect(state).toEqual(snapshot);
    });

    test("projectiles and damage feedback obey their configured caps", () => {
        const state = createCombat(1, {
            projectileCap: 2, effectCap: 1, enemyHealth: 100, criticalChance: 0,
        });
        target(state, 4);
        fireProjectile(state, origin, right);
        fireProjectile(state, origin, right);
        expect(fireProjectile(state, origin, right)).toBeUndefined();
        expect(state.projectiles).toHaveLength(2);
        advanceCombat(state, 0.2, origin, freezePositions(state));
        expect(state.effects).toHaveLength(1);
    });
});

describe("musical combat commands", () => {
    test("bars spawn outside the safety radius with a hard population cap", () => {
        const state = createCombat(12, { enemyCap: 10 });
        const player = { x: 16, z: 16 };
        for (let bar = 0; bar < 20; bar++) {
            spawnOnBeat(state, { index: bar * 4, barIndex: bar }, player);
        }
        expect(state.enemies).toHaveLength(10);
        for (const enemy of state.enemies) {
            expect(Math.hypot(enemy.x - player.x, enemy.z - player.z)).toBeGreaterThanOrEqual(7);
            expect(Math.max(Math.abs(enemy.x), Math.abs(enemy.z))).toBeGreaterThanOrEqual(15);
            expect(Math.max(Math.abs(enemy.x), Math.abs(enemy.z))).toBeLessThanOrEqual(17);
        }
    });

    test("repeated beat commands neither fire nor score twice", () => {
        const state = createCombat(5);
        onCombatBeat(state, { index: 0, barIndex: 0 }, origin, right);
        onCombatBeat(state, { index: 0, barIndex: 0 }, origin, right);
        expect(state.projectiles).toHaveLength(1);
        expect(state.enemies).toHaveLength(1);
        expect(state.score).toBe(2);
        onCombatBeat(state, { index: 1, barIndex: 0 }, origin, right);
        expect(state.projectiles).toHaveLength(2);
        expect(state.enemies).toHaveLength(1);
        expect(state.score).toBe(4);
    });

    test("bar pressure increases in a bounded way and unsatisfiable safety causes no spawn", () => {
        const state = createCombat(5);
        expect(spawnOnBeat(state, { index: 0, barIndex: 0 }, origin)).toHaveLength(1);
        expect(spawnOnBeat(state, { index: 48, barIndex: 12 }, origin)).toHaveLength(2);
        expect(spawnOnBeat(state, { index: 4000, barIndex: 1000 }, origin)).toHaveLength(5);
        const impossible = createCombat(5, { spawnSafetyRadius: 100 });
        expect(spawnOnBeat(impossible, { index: 0, barIndex: 0 }, origin)).toHaveLength(0);
    });

    test("a fixed seed and recorded commands produce the same full outcome", () => {
        const replay = (seed: number) => {
            const state = createCombat(seed, { playerHealth: 1000 });
            for (let tick = 0; tick < 1800; tick++) {
                const phase = tick / 120;
                const player = { x: Math.cos(phase) * 5, z: Math.sin(phase) * 5 };
                if (tick % 30 === 0) {
                    const index = tick / 30;
                    const nearest = [...state.enemies].sort((a, b) =>
                        Math.hypot(a.x - player.x, a.z - player.z)
                        - Math.hypot(b.x - player.x, b.z - player.z),
                    )[0];
                    const aim = nearest ? { x: nearest.x - player.x, z: nearest.z - player.z } : right;
                    onCombatBeat(state, { index, barIndex: Math.floor(index / 4) }, player, aim);
                }
                advanceCombat(state, 1 / 60, player);
            }
            return state;
        };
        const first = replay(77);
        expect(replay(77)).toEqual(first);
        expect(replay(78)).not.toEqual(first);
        expect(first.kills).toBeGreaterThan(0);
    });

    test("external physics poses remain authoritative", () => {
        const state = createCombat(4);
        const enemy = target(state, 5);
        advanceCombat(state, 0.5, origin, new Map([[enemy.id, { x: 9, z: 2 }]]));
        expect({ x: enemy.x, z: enemy.z }).toEqual({ x: 9, z: 2 });
    });

    test("invalid tuning is rejected at the session boundary", () => {
        expect(() => createCombat(1, { damageMin: 20, damageMax: 10 })).toThrow();
        expect(() => createCombat(1, { enemyCap: NaN })).toThrow();
        expect(() => createCombat(1, { fireEveryBeats: 0 })).toThrow();
    });
});
