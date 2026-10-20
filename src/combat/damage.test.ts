import { expect, test } from "bun:test";
import { createEnemy } from "../enemies";
import { removePlayerStatModifier, setPlayerStatModifier } from "../player-stats";
import { advanceCombat, createCombat, fireEnemyProjectile, fireProjectile } from "./index";

const origin = { x: 0, z: 0 };
const right = { x: 1, z: 0 };

test("hits retain target identity and rolled damage while metrics exclude overkill", () => {
    const combat = createCombat(1, {}, { damageMin: 13, damageMax: 13, criticalChance: 0 });
    const enemy = createEnemy(combat.nextId++, { x: 5, z: 0 }, 0, combat.tuning);
    combat.enemies.push(enemy);
    const positions = new Map([[enemy.id, { x: enemy.x, z: enemy.z }]]);
    fireProjectile(combat, origin, right);
    const hit = advanceCombat(combat, 0.2, origin, positions);
    expect(enemy.maxHealth).toBe(24);
    expect(enemy.health).toBe(11);
    expect(hit.events[0]).toMatchObject({ kind: "hit", targetId: enemy.id, amount: 13 });
    expect(combat.playerStats.metrics).toEqual({
        shotsFired: 1, hits: 1, criticalHits: 0, totalDamageDealt: 13, lastHitDamage: 13,
    });

    setPlayerStatModifier(combat.playerStats, "test-damage", { add: { damageMin: 4, damageMax: 4 } });
    fireProjectile(combat, origin, right);
    const kill = advanceCombat(combat, 0.2, origin, positions);
    expect(kill.events[0]).toMatchObject({ kind: "kill", targetId: enemy.id, amount: 17 });
    expect(enemy.maxHealth).toBe(24);
    expect(enemy.health).toBe(0);
    expect(combat.playerStats.metrics).toEqual({
        shotsFired: 2, hits: 2, criticalHits: 0, totalDamageDealt: 24, lastHitDamage: 11,
    });
    expect(combat.kills).toBe(1);
    expect(combat.experience.drops).toHaveLength(1);
    fireProjectile(combat, origin, right);
    advanceCombat(combat, 2, origin, positions);
    expect(combat.playerStats.metrics.shotsFired).toBe(3);
    expect(combat.playerStats.metrics.totalDamageDealt).toBe(24);
    expect(combat.playerStats.metrics.hits).toBe(2);
});

test("stat modifiers affect new shots, while in-flight damage and enemy health capacity stay fixed", () => {
    const combat = createCombat(8, { enemyHealth: 100 }, { criticalChance: 0 });
    const enemy = createEnemy(combat.nextId++, { x: 5, z: 0 }, 0, combat.tuning);
    combat.enemies.push(enemy);
    const positions = new Map([[enemy.id, { x: enemy.x, z: enemy.z }]]);
    const before = fireProjectile(combat, origin, right)!;
    const originalDamage = before.damage;
    setPlayerStatModifier(combat.playerStats, "test-double", { multiply: { damageMin: 2, damageMax: 2 } });
    combat.tuning.enemyHealth = 200;
    expect(before.damage).toBe(originalDamage);
    const after = fireProjectile(combat, origin, right)!;
    expect(after.damage).toBeGreaterThanOrEqual(26);
    expect(after.damage).toBeLessThanOrEqual(34);
    advanceCombat(combat, 0.2, origin, positions);
    expect(enemy.maxHealth).toBe(100);
    expect(enemy.health).toBe(100 - originalDamage - after.damage);
    expect(combat.playerStats.metrics.totalDamageDealt).toBe(originalDamage + after.damage);
    removePlayerStatModifier(combat.playerStats, "test-double");
    const restored = fireProjectile(combat, origin, right)!;
    expect(restored.damage).toBeGreaterThanOrEqual(13);
    expect(restored.damage).toBeLessThanOrEqual(17);
});

test("critical hits are counted once and blocked or hostile shots do not inflate player metrics", () => {
    const combat = createCombat(9, { projectileCap: 3 }, {
        damageMin: 15, damageMax: 15, criticalChance: 1,
    });
    const enemy = createEnemy(combat.nextId++, { x: 5, z: 0 }, 0, combat.tuning);
    combat.enemies.push(enemy);
    fireEnemyProjectile(combat, enemy, { x: -1, z: 0 });
    expect(combat.playerStats.metrics.shotsFired).toBe(0);
    fireProjectile(combat, origin, right);
    fireProjectile(combat, origin, right);
    expect(fireProjectile(combat, origin, right)).toBeUndefined();
    const hit = advanceCombat(combat, 0.5, origin, new Map([[enemy.id, { x: 5, z: 0 }]]));
    expect(hit.events.find(event => event.kind === "kill"))
        .toMatchObject({ amount: 30, critical: true, targetId: enemy.id });
    expect(combat.playerStats.metrics).toEqual({
        shotsFired: 2, hits: 1, criticalHits: 1, totalDamageDealt: 24, lastHitDamage: 24,
    });
    advanceCombat(combat, 2, origin);
    expect(combat.playerStats.metrics.hits).toBe(1);
});

test("new runs isolate modifiers and metrics, and seeded damage stays repeatable", () => {
    const first = createCombat(2026);
    setPlayerStatModifier(first.playerStats, "test-bonus", { add: { damageMin: 2, damageMax: 2 } });
    fireProjectile(first, origin, right);
    const fresh = createCombat(2026);
    expect(fresh.playerStats.effective.damageMin).toBe(13);
    expect(fresh.playerStats.modifiers).toEqual({});
    expect(fresh.playerStats.metrics.shotsFired).toBe(0);
    const same = createCombat(2026);
    for (let i = 0; i < 100; i++) {
        const shot = fireProjectile(fresh, origin, right)!;
        expect(shot).toEqual(fireProjectile(same, origin, right)!);
        expect(shot.damage).toBeGreaterThanOrEqual(shot.critical ? 26 : 13);
        expect(shot.damage).toBeLessThanOrEqual(shot.critical ? 34 : 17);
    }
});
