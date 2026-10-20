import { describe, expect, test } from "bun:test";
import { createEnemy } from "../enemies";
import { dropExperience } from "../experience/state";
import { setPlayerStatModifier } from "../player-stats";
import { prepareUpgradeChoices, queueUpgradeLevels } from "../upgrades";
import {
    advanceCombat, createCombat, fireEnemyProjectile, fireProjectile, fireVolley,
    onCombatBeat, type CombatState,
} from "./index";

const origin = { x: 0, z: 0 }, right = { x: 1, z: 0 };
function fixture(stats: Parameters<typeof createCombat>[2] = {}): CombatState {
    return createCombat(45, {
        enemyCap: 0, enemySpeed: 0, enemyMaxSpeed: 0, enemySpeedIncrease: 0,
        contactDamage: 0, knockbackSpeed: 0,
    }, { damageMin: 13, damageMax: 13, criticalChance: 0, ...stats });
}
function enemy(combat: CombatState, x: number, z = 0) {
    const target = createEnemy(combat.nextId++, { x, z }, 0, combat.tuning);
    combat.enemies.push(target);
    return target;
}
function beat(combat: CombatState, index: number, time = index * 0.5, downbeat = false) {
    return onCombatBeat(combat, {
        index, barIndex: Math.floor(index / 4), time, isDownbeat: downbeat,
    }, origin, { x: -1, z: 0 });
}

describe("upgraded music-timed combat", () => {
    test("fan volleys center odd/even counts on aim and use a maximum 60 degree spread", () => {
        for (let count = 1; count <= 7; count++) {
            const combat = fixture({ projectileCount: count });
            const shots = fireVolley(combat, origin, right);
            expect(shots).toHaveLength(count);
            const angles = shots.map(shot => Math.atan2(shot.velocityZ, shot.velocityX));
            expect(angles.reduce((sum, angle) => sum + angle, 0)).toBeCloseTo(0);
            expect(Math.max(...angles) - Math.min(...angles)).toBeLessThanOrEqual(Math.PI / 3 + 1e-12);
            expect(combat.lastAim).toEqual(right);
            expect(combat.playerStats.metrics.shotsFired).toBe(count);
            for (const shot of shots) {
                expect(Math.hypot(shot.velocityX, shot.velocityZ)).toBeCloseTo(combat.tuning.projectileSpeed);
                expect(shot.damage).toBe(13);
            }
        }
    });

    test("partial projectile budgets preserve a centered fan and do not roll rejected shots", () => {
        const combat = fixture({ projectileCount: 7 });
        combat.tuning.projectileCap = 2;
        const shots = fireVolley(combat, origin, right);
        expect(shots).toHaveLength(2);
        expect(shots[0]!.velocityZ).toBeCloseTo(-shots[1]!.velocityZ);
        const random = combat.randomState;
        expect(fireVolley(combat, origin, right)).toEqual([]);
        expect(combat.randomState).toBe(random);
        expect(combat.playerStats.metrics.shotsFired).toBe(2);
    });

    test("barrage fires radial spokes only on explicit main beats, once per beat", () => {
        const combat = fixture({ projectileCount: 2, barrageCount: 6 });
        beat(combat, 0, 0, false);
        expect(combat.projectiles).toHaveLength(2);
        combat.projectiles = [];
        beat(combat, 1, 0.4, true); // Authored mixed meter can put an accent at any index.
        expect(combat.projectiles).toHaveLength(8);
        const barrage = combat.projectiles.slice(2);
        expect(barrage.reduce((sum, shot) => sum + shot.velocityX, 0)).toBeCloseTo(0);
        expect(barrage.reduce((sum, shot) => sum + shot.velocityZ, 0)).toBeCloseTo(0);
        const snapshot = structuredClone(combat.projectiles);
        expect(beat(combat, 1, 0.4, true)).toEqual([]);
        expect(combat.projectiles).toEqual(snapshot);
        combat.projectiles = [];
        onCombatBeat(combat, { index: 4, barIndex: 1 }, origin, right);
        expect(combat.projectiles).toHaveLength(2); // Inferred groups are not accents.
    });

    test("barrage shares the hard projectile cap and preserves aim", () => {
        const combat = fixture({ projectileCount: 7, barrageCount: 24 });
        combat.tuning.projectileCap = 10;
        beat(combat, 0, 0, true);
        expect(combat.projectiles).toHaveLength(10);
        expect(combat.lastAim).toEqual({ x: -1, z: 0 });
        expect(combat.playerStats.metrics.shotsFired).toBe(10);
    });

    test("regeneration waits five music seconds and restores once on the next actual beat", () => {
        const combat = fixture({ healthRegen: 2 });
        combat.health = 50;
        beat(combat, 0, 0);
        advanceCombat(combat, 8, origin); // Fixed-time drift is not the healing clock.
        expect(combat.health).toBe(50);
        beat(combat, 1, 4.99);
        expect(combat.health).toBe(50);
        beat(combat, 2, 5.4);
        expect(combat.health).toBe(52);
        expect(combat.regenerationDueAt).toBe(10.4);
        beat(combat, 3, 25); // A detection gap produces one heal, never a backlog.
        expect(combat.health).toBe(54);
        expect(combat.regenerationDueAt).toBe(30);
        beat(combat, 3, 25);
        expect(combat.health).toBe(54);
        combat.health = 99;
        beat(combat, 4, 30);
        expect(combat.health).toBe(100);
    });

    test("runtime maximum health comes from player stats, with legacy tuning only as an initial value", () => {
        expect(createCombat(1, { playerHealth: 40 }).playerStats.effective.maxHealth).toBe(40);
        expect(createCombat(1, { playerHealth: 40 }, { maxHealth: 80 }).health).toBe(80);
        const combat = fixture({ maxHealth: 120, healthRegen: 10 });
        combat.tuning.playerHealth = 1;
        combat.health = 115;
        beat(combat, 0, 5);
        expect(combat.health).toBe(120);
    });

    test("ricochets wait in place and cannot hit a second target before the next beat", () => {
        const combat = fixture({ bounces: 2 });
        const first = enemy(combat, 3);
        const second = enemy(combat, 6);
        const third = enemy(combat, 9);
        const shot = fireProjectile(combat, origin, right)!;
        advanceCombat(combat, 0.3, origin);
        expect(first.health).toBe(11);
        expect(second.health).toBe(24);
        expect(third.health).toBe(24);
        expect(shot.waitingForBounce).toBe(true);
        expect(shot.bouncesRemaining).toBe(2);
        const resting = { x: shot.x, z: shot.z, lifetime: shot.remainingLifetime };
        for (let i = 0; i < 50; i++) advanceCombat(combat, 0.1, origin);
        expect({ x: shot.x, z: shot.z, lifetime: shot.remainingLifetime }).toEqual(resting);
        expect(combat.playerStats.metrics.hits).toBe(1);
        beat(combat, 0, 0.5);
        expect(shot.waitingForBounce).toBe(false);
        expect(shot.bouncesRemaining).toBe(1);
        advanceCombat(combat, 0.3, origin);
        expect(first.health).toBe(11);
        expect(second.health).toBe(15); // First bounce: round(13 × 0.7) = 9.
        expect(third.health).toBe(24);
        expect(shot.waitingForBounce).toBe(true);
        expect(shot.hitEnemyIds).toEqual([first.id, second.id]);
        beat(combat, 0, 0.5); // Duplicate delivery cannot release again.
        advanceCombat(combat, 0.3, origin);
        expect(third.health).toBe(24);
        beat(combat, 1, 0.9);
        advanceCombat(combat, 0.3, origin);
        expect(third.health).toBe(18); // Second bounce: round(13 × 0.7²) = 6.
        expect(combat.projectiles.some(projectile => projectile.id === shot.id)).toBe(false);
        expect(combat.playerStats.metrics.hits).toBe(3);
        expect(combat.playerStats.metrics.totalDamageDealt).toBe(28);
    });

    test("ricochets choose nearest unhit enemy, resolve ties by ID and retire with no target", () => {
        const combat = fixture({ bounces: 3 });
        const first = enemy(combat, 3);
        const shot = fireProjectile(combat, origin, right)!;
        advanceCombat(combat, 0.2, origin);
        const lowerId = enemy(combat, shot.x, 3);
        const higherId = enemy(combat, shot.x, -3);
        beat(combat, 0);
        expect(shot.velocityZ).toBeGreaterThan(0);
        advanceCombat(combat, 0.2, origin);
        expect(lowerId.health).toBe(15);
        expect(higherId.health).toBe(24);
        higherId.health = 0;
        beat(combat, 1);
        expect(combat.projectiles.some(projectile => projectile.id === shot.id)).toBe(false);
        expect(first.health).toBe(11);
    });

    test("bounce budgets and damage are captured before upgrades change future projectiles", () => {
        const combat = fixture({ bounces: 1 });
        const old = fireProjectile(combat, origin, right)!;
        setPlayerStatModifier(combat.playerStats, "upgrade", {
            add: { bounces: 2, damageMin: 3, damageMax: 3 },
        });
        const next = fireProjectile(combat, origin, right)!;
        expect(old.bouncesRemaining).toBe(1);
        expect(old.damage).toBe(13);
        expect(next.bouncesRemaining).toBe(3);
        expect(next.damage).toBe(16);
    });

    test("all five bounces compound from fired damage without rounding drift or upgrade changes", () => {
        for (const [stats, damage] of [
            [{ damageMin: 15, damageMax: 15 }, [15, 11, 7, 5, 4, 3]],
            [{ damageMin: 25, damageMax: 25, criticalChance: 1 }, [50, 35, 25, 17, 12, 8]],
            [{ damageMin: 25, damageMax: 25, damageMultiplier: 0.8, criticalChance: 1 }, [40, 28, 20, 14, 10, 7]],
        ] as const) {
            const combat = fixture({ ...stats, bounces: 5 });
            combat.tuning.enemyHealth = 100;
            const targets = Array.from({ length: 6 }, (_, i) => enemy(combat, 3 + i * 3));
            const shot = fireProjectile(combat, origin, right)!;
            setPlayerStatModifier(combat.playerStats, "later-upgrade", {
                add: { damageMin: 30, damageMax: 30 }, multiply: { damageMultiplier: 0.5 },
            });
            for (let i = 0; i < targets.length; i++) {
                if (i > 0) {
                    beat(combat, i - 1);
                    expect(shot.damage).toBe(damage[i]!);
                    beat(combat, i - 1); // No double attenuation on a duplicate.
                    expect(shot.damage).toBe(damage[i]!);
                }
                advanceCombat(combat, 0.2, origin);
                expect(targets[i]!.health).toBe(100 - damage[i]!);
            }
            expect(combat.projectiles.some(item => item.id === shot.id)).toBe(false);
            expect(combat.playerStats.metrics.totalDamageDealt).toBe(damage.reduce((sum, value) => sum + value, 0));
        }
    });

    test("global damage reductions apply equally to the fan, barrage and critical hits", () => {
        const combat = fixture({
            damageMin: 25, damageMax: 25, damageMultiplier: 0.8,
            criticalChance: 1, projectileCount: 3, barrageCount: 6,
        });
        beat(combat, 0, 0, true);
        expect(combat.projectiles).toHaveLength(9);
        expect(combat.projectiles.every(shot => shot.damage === 40 && shot.initialDamage === 40 && shot.critical)).toBe(true);
        setPlayerStatModifier(combat.playerStats, "later-penalty", { multiply: { damageMultiplier: 0.5 } });
        expect(combat.projectiles.every(shot => shot.damage === 40)).toBe(true);
        expect(fireProjectile(combat, origin, right)!.damage).toBe(20);
    });

    test("multi-level XP collection queues every upgrade once", () => {
        const combat = fixture();
        dropExperience(combat.experience, origin, 100);
        advanceCombat(combat, 0.1, origin);
        expect(combat.experience.level).toBe(3);
        expect(combat.experience.xp).toBe(10);
        expect(combat.upgrades.pending).toBe(2);
        advanceCombat(combat, 0.1, origin);
        expect(combat.upgrades.pending).toBe(2);
        expect(combat.upgrades.earnedThrough).toBe(3);
    });

    test("pending upgrades do not protect the player from hostile shots or contact", () => {
        const combat = fixture();
        combat.tuning.contactDamage = 15;
        queueUpgradeLevels(combat.upgrades, 2);
        prepareUpgradeChoices(combat);
        const shooter = enemy(combat, -3);
        enemy(combat, 0);
        fireEnemyProjectile(combat, shooter, right);
        advanceCombat(combat, 0.3, origin);
        expect(combat.health).toBeLessThan(100);
        expect(combat.invulnerableUntil).toBeGreaterThan(0);
        expect(combat.projectiles).toHaveLength(0);
        expect(combat.upgrades.pending).toBe(1);
    });
});
