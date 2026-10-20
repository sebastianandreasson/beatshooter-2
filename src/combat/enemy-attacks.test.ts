import { describe, expect, test } from "bun:test";
import { createEnemy, type EnemyKind } from "../enemies";
import {
    advanceCombat, createCombat, fireEnemyProjectile, fireProjectile, onCombatBeat,
    PLAYER_COLLISION_GROUP, type CombatState, type CombatTuning,
} from "./index";

const origin = { x: 0, z: 0 }, right = { x: 1, z: 0 };
const fixture = (tuning: Partial<CombatTuning> = {}) =>
    createCombat(19, { initialWaveSize: 0, maxWaveSize: 0, ...tuning });
const hostile = (state: CombatState) =>
    state.projectiles.filter(shot => shot.collisionMask & PLAYER_COLLISION_GROUP);
function enemy(state: CombatState, kind: EnemyKind, x: number, z = 0) {
    const target = createEnemy(state.nextId++, { x, z }, 0, state.tuning, kind);
    state.enemies.push(target);
    return target;
}
const poses = (state: CombatState) =>
    new Map(state.enemies.map(target => [target.id, { x: target.x, z: target.z }]));

describe("musical enemy attacks", () => {
    test("spinner waits a bar, rotates once, and fires three equally separated rays", () => {
        const state = fixture();
        const spinner = enemy(state, "spinner", 10);
        onCombatBeat(state, { index: 0, barIndex: 0, isDownbeat: true }, origin, right);
        expect(hostile(state)).toHaveLength(0);
        expect(spinner.heading).toBe(0);
        onCombatBeat(state, { index: 1, barIndex: 0, isDownbeat: false }, origin, right);
        expect(hostile(state)).toHaveLength(0);
        onCombatBeat(state, { index: 3, barIndex: 1, isDownbeat: true }, origin, right);
        expect(spinner.heading).toBeCloseTo(Math.PI / 6);
        const volley = hostile(state);
        expect(volley).toHaveLength(3);
        for (let i = 0; i < 3; i++) {
            const shot = volley[i]!, next = volley[(i + 1) % 3]!;
            expect(shot.shooterId).toBe(spinner.id);
            expect(Math.hypot(shot.velocityX, shot.velocityZ)).toBeCloseTo(9);
            expect((shot.velocityX * next.velocityX + shot.velocityZ * next.velocityZ) / 81)
                .toBeCloseTo(-0.5);
            expect(Math.hypot(shot.x - spinner.x, shot.z - spinner.z)).toBeCloseTo(0.8);
        }
        expect(volley[0]!.velocityX / 9).toBeCloseTo(Math.sin(spinner.heading));
        onCombatBeat(state, { index: 3, barIndex: 1, isDownbeat: true }, origin, right);
        onCombatBeat(state, { index: 4, barIndex: 1, isDownbeat: true }, origin, right);
        expect(hostile(state)).toHaveLength(3);
        expect(spinner.heading).toBeCloseTo(Math.PI / 6);
        // Inferred/unaccented boundaries and ordinary beats never grant attacks.
        onCombatBeat(state, { index: 8, barIndex: 2, isDownbeat: false }, origin, right);
        expect(hostile(state)).toHaveLength(3);
        expect(spinner.heading).toBeCloseTo(Math.PI / 6);
        onCombatBeat(state, { index: 11, barIndex: 3, isDownbeat: true }, origin, right);
        expect(hostile(state)).toHaveLength(6);
        expect(spinner.heading).toBeCloseTo(Math.PI / 3);
    });

    test("ranger fires one aimed shot only in range on the main beat, without homing", () => {
        const state = fixture();
        const ranger = enemy(state, "ranger", 8);
        onCombatBeat(state, { index: 4, barIndex: 1, isDownbeat: true }, origin, right);
        expect(hostile(state)).toHaveLength(0);
        ranger.x = 6;
        onCombatBeat(state, { index: 5, barIndex: 1, isDownbeat: false }, origin, right);
        expect(hostile(state)).toHaveLength(0);
        onCombatBeat(state, { index: 8, barIndex: 2, isDownbeat: true }, { x: 3, z: 4 }, right);
        const shot = hostile(state)[0]!;
        expect(hostile(state)).toHaveLength(1);
        expect(shot.velocityX).toBeCloseTo(-5.4);
        expect(shot.velocityZ).toBeCloseTo(7.2);
        expect(ranger.heading).toBeCloseTo(Math.atan2(-3, 4));
        advanceCombat(state, 0.05, { x: -8, z: -8 }, poses(state));
        expect(shot.velocityX).toBeCloseTo(-5.4);
        expect(shot.velocityZ).toBeCloseTo(7.2);
        expect(hostile(state)).toHaveLength(1);
    });

    test("dead shooters and chasers cannot attack, including after defeat", () => {
        const state = fixture();
        enemy(state, "chaser", 5);
        enemy(state, "spinner", 6).health = 0;
        onCombatBeat(state, { index: 4, barIndex: 1, isDownbeat: true }, origin, right);
        expect(hostile(state)).toHaveLength(0);
        const ranger = enemy(state, "ranger", 6);
        state.defeated = true;
        expect(fireEnemyProjectile(state, ranger, right)).toBeUndefined();
        const before = structuredClone(state);
        onCombatBeat(state, { index: 8, barIndex: 2, isDownbeat: true }, origin, right);
        expect(state).toEqual(before);
    });

    test("hostile caps preserve a player slot and never emit a partial three-way volley", () => {
        const state = fixture({ enemyProjectileCap: 3, projectileCap: 4 });
        const spinner = enemy(state, "spinner", 10);
        for (let i = 0; i < 3; i++) expect(fireEnemyProjectile(state, spinner, right)).toBeDefined();
        expect(fireEnemyProjectile(state, spinner, right)).toBeUndefined();
        expect(fireProjectile(state, origin, right)).toBeDefined();
        expect(state.projectiles).toHaveLength(4);
        expect(fireProjectile(state, origin, right)).toBeUndefined();
        const small = fixture({ enemyProjectileCap: 2 });
        const other = enemy(small, "spinner", 10);
        onCombatBeat(small, { index: 4, barIndex: 1, isDownbeat: true }, origin, right);
        expect(hostile(small)).toHaveLength(0);
        expect(other.heading).toBeCloseTo(Math.PI / 6);
    });
});

describe("hostile projectile collision and lifetime", () => {
    test("a swept hostile shot hits the player once and passes through enemies", () => {
        const state = fixture();
        const shooter = enemy(state, "ranger", -5);
        const ally = enemy(state, "spinner", -2);
        fireEnemyProjectile(state, shooter, right);
        const result = advanceCombat(state, 1, origin, poses(state));
        expect(state.health).toBe(90);
        expect(ally.health).toBe(state.tuning.enemyHealth);
        expect(shooter.health).toBe(state.tuning.enemyHealth);
        expect(state.projectiles).toHaveLength(0);
        expect(result.playerDamaged).toBe(true);
        expect(result.events.map(event => [event.kind, event.amount])).toEqual([["player-hit", 10]]);
        expect(state.kills).toBe(0);
        advanceCombat(state, 1, origin, poses(state));
        expect(state.health).toBe(90);
    });

    test("bullets and contact share immunity, and absorbed bullets cannot linger", () => {
        const state = fixture();
        const shooter = enemy(state, "ranger", -5);
        enemy(state, "chaser", 1.1);
        fireEnemyProjectile(state, shooter, right);
        fireEnemyProjectile(state, shooter, right);
        advanceCombat(state, 0.5, origin, poses(state));
        expect(state.health).toBe(90);
        expect(state.projectiles).toHaveLength(0);
        fireEnemyProjectile(state, shooter, right);
        advanceCombat(state, 0.5, origin, poses(state));
        expect(state.health).toBe(90);
        expect(state.projectiles).toHaveLength(0);
        advanceCombat(state, 0.5, origin, poses(state));
        expect(state.health).toBe(75);
        fireEnemyProjectile(state, shooter, right);
        advanceCombat(state, 0.5, origin, poses(state));
        expect(state.health).toBe(75);
    });

    test("relative sweeps catch a dash crossing a slow shot, without extending its lifetime", () => {
        const run = (lifetime: number) => {
            const state = fixture({ enemyProjectileSpeed: 0, enemyProjectileLifetime: lifetime });
            const shooter = enemy(state, "ranger", -0.8);
            fireEnemyProjectile(state, shooter, right); // Muzzle at the origin.
            advanceCombat(state, 1, { x: 3, z: 0 }, poses(state), { x: -3, z: 0 });
            expect(state.projectiles).toHaveLength(0);
            return state;
        };
        expect(run(1).health).toBe(90);
        expect(run(0.25).health).toBe(100);
    });

    test("immunity is checked at impact even when it expires before tick end", () => {
        const state = fixture();
        state.invulnerableUntil = 0.01;
        fireEnemyProjectile(state, enemy(state, "ranger", -1.55), right);
        advanceCombat(state, 1 / 60, origin, poses(state));
        expect(state.health).toBe(100);
        expect(state.projectiles).toHaveLength(0);
    });

    test("a killing shot emits defeat and remains terminal", () => {
        const state = fixture({ playerHealth: 5 });
        fireEnemyProjectile(state, enemy(state, "ranger", -5), right);
        const result = advanceCombat(state, 1, origin, poses(state));
        expect(result.defeated).toBe(true);
        expect(state.health).toBe(0);
        const frozen = structuredClone(state);
        advanceCombat(state, 1, origin);
        expect(state).toEqual(frozen);
    });

    test("missed shots expire and leave the arena within the existing projectile boundary", () => {
        const state = fixture({ enemyProjectileLifetime: 0.1 });
        fireEnemyProjectile(state, enemy(state, "ranger", -5), { x: 0, z: 1 });
        advanceCombat(state, 0.2, origin, poses(state));
        expect(state.health).toBe(100);
        expect(state.projectiles).toHaveLength(0);
        const outer = fixture();
        fireEnemyProjectile(outer, enemy(outer, "spinner", 17), right);
        advanceCombat(outer, 0.2, origin, poses(outer));
        expect(outer.projectiles).toHaveLength(0);
        expect(() => createCombat(1, { rangerStopDistance: 8, rangerFireRange: 7 })).toThrow();
    });
});
