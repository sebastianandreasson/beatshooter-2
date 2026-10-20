import { expect, test } from "bun:test";
import { createEnemy } from "../enemies";
import { configureEncounter, stopEncounter } from "../encounters";
import { dropExperience } from "../experience/state";
import { createPickups, type PickupKind } from "../pickups/state";
import { generateTimeline } from "../rhythm/timeline";
import { advanceCombat, createCombat, fireProjectile, type CombatState } from "./index";

const origin = { x: 0, z: 0 };
const poses = (combat: CombatState) => new Map(combat.enemies.map(enemy => [enemy.id, { x: enemy.x, z: enemy.z }]));
function pickup(combat: CombatState, kind: PickupKind, x = 0, z = 0) {
    combat.pickups.drops.push({ id: 1, kind, x, z, spawnAt: 0 });
}

test("health restores 50 once, clamps to upgraded max health and catches dash crossings", () => {
    const combat = createCombat(42, {}, { maxHealth: 140 });
    combat.health = 30;
    pickup(combat, "health");
    advanceCombat(combat, 1 / 60, { x: 3, z: 0 }, undefined, { x: -3, z: 0 });
    expect(combat.health).toBe(80);
    expect(combat.pickups.drops).toEqual([]);
    expect(combat.pickups.collected.health).toBe(1);
    advanceCombat(combat, 1 / 60, origin);
    expect(combat.health).toBe(80);
    combat.health = 125;
    pickup(combat, "health");
    advanceCombat(combat, 1 / 60, origin);
    expect(combat.health).toBe(140);
    expect(combat.pickups.notice?.amount).toBe(15);
});

test("magnet draws all existing XP across the arena, awards on arrival and queues normal upgrades", () => {
    const combat = createCombat();
    dropExperience(combat.experience, { x: -16, z: -16 }, 40);
    dropExperience(combat.experience, { x: 16, z: 16 }, 50);
    pickup(combat, "magnet");
    advanceCombat(combat, 1 / 60, origin);
    expect(combat.experience.drops.every(drop => drop.attracted && drop.speed > 0)).toBe(true);
    expect(combat.experience.totalXp).toBe(0);
    const later = dropExperience(combat.experience, { x: 15, z: -15 });
    for (let i = 0; i < 120; i++) advanceCombat(combat, 1 / 60, origin);
    expect(combat.experience.totalXp).toBe(90);
    expect(combat.experience.level).toBe(3);
    expect(combat.upgrades.pending).toBe(2);
    expect(combat.experience.drops).toEqual([later]);
    expect(later.attracted).toBe(false);
    expect(combat.pickups.collected.magnet).toBe(1);
});

test("bomb expands to a quarter-width radius, hits each live enemy once and leaves pending enemies alone", () => {
    const combat = createCombat(42, { enemyHealth: 150 });
    const near = createEnemy(1, { x: 3, z: 0 }, 0, combat.tuning);
    const far = createEnemy(2, { x: 8, z: 0 }, 0, combat.tuning);
    const outside = createEnemy(3, { x: 10, z: 0 }, 0, combat.tuning);
    combat.enemies.push(near, far, outside);
    combat.pendingSpawns.push({ enemy: createEnemy(4, { x: 2, z: 0 }, 0, combat.tuning),
        startTime: 0, endTime: 1, activateBeat: 2 });
    pickup(combat, "bomb");
    advanceCombat(combat, 0.01, origin, poses(combat), origin, 1);
    expect(near.health).toBe(150);
    expect(combat.pickups.waves[0]!.maxRadius).toBe(9);
    advanceCombat(combat, 0.01, origin, poses(combat), origin, 1.25);
    expect(near.health).toBe(50);
    expect(far.health).toBe(150);
    for (let i = 0; i < 20; i++) advanceCombat(combat, 0.01, origin, poses(combat), origin, 1.25);
    expect(near.health).toBe(50);
    expect(combat.pickups.waves[0]!.radius).toBe(3);
    // A delayed observation must still sweep the final section of the wave.
    advanceCombat(combat, 0.01, origin, poses(combat), origin, 2);
    expect(far.health).toBe(50);
    expect(outside.health).toBe(150);
    expect(combat.pendingSpawns[0]!.enemy.health).toBe(150);
    expect(combat.playerStats.metrics.totalDamageDealt).toBe(200);
    expect(combat.health).toBe(100);
    advanceCombat(combat, 0.01, origin, poses(combat), origin, 2.1);
    expect(combat.pickups.waves).toEqual([]);
});

test("bomb kills use normal score, XP, elite rewards and damage feedback without double credit", () => {
    const combat = createCombat();
    const encounter = configureEncounter(combat, { id: "elite-hunt", duration: 60,
        beats: generateTimeline(60, 120), stageIndex: 0, seed: 42, entryNextLevelXp: 54 });
    const enemy = createEnemy(combat.nextId++, { x: 7, z: 0 }, 0, combat.tuning);
    combat.enemies.push(enemy);
    encounter.eliteId = enemy.id;
    encounter.enemies.set(enemy.id, { xp: 10, group: 0, elite: true });
    pickup(combat, "bomb");
    advanceCombat(combat, 0.01, origin, poses(combat), origin, 0);
    const hit = advanceCombat(combat, 0.01, origin, poses(combat), origin, 0.75);
    expect(hit.killedIds).toEqual([enemy.id]);
    expect(hit.events).toContainEqual(expect.objectContaining({ kind: "kill", targetId: enemy.id, amount: 100 }));
    expect(combat.kills).toBe(1);
    expect(combat.score).toBe(100);
    expect(combat.experience.drops).toHaveLength(1);
    expect(combat.playerStats.metrics.totalDamageDealt).toBe(24);
    expect(encounter.ordinaryXp).toBe(10);
    expect(encounter.eliteDefeated).toBe(true);
    fireProjectile(combat, origin, { x: 1, z: 0 });
    advanceCombat(combat, 0.3, origin, poses(combat), origin, 1);
    expect(combat.kills).toBe(1);
    expect(combat.experience.drops).toHaveLength(1);
});

test("defeat and stopped campaign encounters freeze pickups; a fresh song clears them", () => {
    const combat = createCombat();
    combat.pickups = createPickups(42, 60);
    pickup(combat, "health");
    combat.health = 0; combat.defeated = true;
    const frozen = structuredClone(combat.pickups);
    advanceCombat(combat, 1, origin, undefined, origin, 30);
    expect(combat.pickups).toEqual(frozen);
    expect(combat.health).toBe(0);
    combat.health = 20; combat.defeated = false;
    configureEncounter(combat, { id: "mixed-assault", duration: 60, beats: generateTimeline(60, 120),
        stageIndex: 0, seed: 42, entryNextLevelXp: 54 });
    stopEncounter(combat);
    advanceCombat(combat, 1, origin, undefined, origin, 30);
    expect(combat.pickups).toEqual(frozen);
    expect(createCombat().pickups.drops).toEqual([]);
    expect(createCombat().pickups.waves).toEqual([]);
});
