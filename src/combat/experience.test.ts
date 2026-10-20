import { expect, test } from "bun:test";
import { createEnemy, type EnemyKind } from "../enemies";
import { DEFAULT_EXPERIENCE_TUNING, dropExperience } from "../experience/state";
import { advanceCombat, createCombat, fireProjectile, type CombatState } from "./index";

const origin = { x: 0, z: 0 }, right = { x: 1, z: 0 };
const poses = (state: CombatState) =>
    new Map(state.enemies.map(enemy => [enemy.id, { x: enemy.x, z: enemy.z }]));

test("every enemy archetype leaves one XP drop on death without awarding XP at range", () => {
    const state = createCombat(51, {}, { damageMin: 30, damageMax: 30, criticalChance: 0 });
    for (const [index, kind] of (["chaser", "spinner", "ranger"] as EnemyKind[]).entries()) {
        state.enemies.push(createEnemy(state.nextId++, { x: 5 + index * 4, z: 0 }, 0, state.tuning, kind));
        fireProjectile(state, origin, right);
    }
    const result = advanceCombat(state, 0.5, origin, poses(state));
    expect(result.killedIds).toHaveLength(3);
    expect(state.experience.drops.map(drop => [drop.x, drop.z, drop.value])).toEqual([
        [5, 0, 10], [9, 0, 10], [13, 0, 10],
    ]);
    expect(state.experience.totalXp).toBe(0);
    expect(state.experience.level).toBe(1);
    expect(state.score).toBe(300);
    advanceCombat(state, 0.5, origin);
    expect(state.experience.drops).toHaveLength(3);
    expect(state.experience.totalXp).toBe(0);
});

test("damage without a kill and duplicate projectiles cannot duplicate XP", () => {
    const state = createCombat(51, {}, { damageMin: 10, damageMax: 10, criticalChance: 0 });
    state.enemies.push(createEnemy(state.nextId++, { x: 5, z: 0 }, 0, state.tuning));
    fireProjectile(state, origin, right);
    advanceCombat(state, 0.25, origin, poses(state));
    expect(state.experience.drops).toHaveLength(0);
    for (let i = 0; i < 3; i++) fireProjectile(state, origin, right);
    advanceCombat(state, 0.25, origin, poses(state));
    expect(state.kills).toBe(1);
    expect(state.experience.drops).toHaveLength(1);
    expect(state.experience.drops[0]!.value).toBe(10);
    expect(state.experience.totalXp).toBe(0);
});

test("approaching gems grants XP on arrival and publishes one level celebration for crossed thresholds", () => {
    const state = createCombat();
    dropExperience(state.experience, { x: 5, z: 0 }, 90);
    advanceCombat(state, 0.1, origin);
    expect(state.experience.totalXp).toBe(0);
    const player = { x: 2, z: 0 };
    advanceCombat(state, 1 / 60, player);
    expect(state.experience.drops[0]!.attracted).toBe(true);
    expect(state.experience.totalXp).toBe(0);
    const events = [];
    for (let i = 0; i < 120; i++) {
        events.push(...advanceCombat(state, 1 / 60, player).events);
    }
    expect(state.experience.drops).toHaveLength(0);
    expect(state.experience.totalXp).toBe(90);
    expect(state.experience.level).toBe(3);
    expect(state.experience.xp).toBe(0);
    expect(state.experience.requiredXp).toBe(72);
    expect(events.filter(event => event.kind === "level-up")).toEqual([
        expect.objectContaining({ kind: "level-up", x: 2, z: 0, amount: 3, critical: false }),
    ]);
    expect(state.health).toBe(100);
    expect(state.score).toBe(0);
    expect(state.kills).toBe(0);
});

test("defeat prevents further collection and a new session resets levels and all drop ownership", () => {
    const state = createCombat(51, { playerHealth: 15 });
    dropExperience(state.experience, origin, 90);
    state.enemies.push(createEnemy(state.nextId++, { x: 1.1, z: 0 }, 0, state.tuning));
    const result = advanceCombat(state, 1 / 60, origin, poses(state));
    expect(result.defeated).toBe(true);
    expect(result.events.some(event => event.kind === "level-up")).toBe(false);
    expect(state.experience.totalXp).toBe(0);
    const held = structuredClone(state);
    advanceCombat(state, 5, origin);
    expect(state).toEqual(held);
    const next = createCombat();
    expect(next.experience.level).toBe(1);
    expect(next.experience.xp).toBe(0);
    expect(next.experience.totalXp).toBe(0);
    expect(next.experience.requiredXp).toBe(DEFAULT_EXPERIENCE_TUNING.initialRequirement);
    expect(next.experience.drops).toHaveLength(0);
});
