import { describe, expect, test } from "bun:test";
import { createEnemy } from "../enemies";
import { advanceCombat, createCombat, fireProjectile, onCombatBeat, spawnOnBeat } from "./index";

const origin = { x: 0, z: 0 }, right = { x: 1, z: 0 };
const command = (index: number, time: number, nextBeatTime: number | null, barIndex = 0) =>
    ({ index, time, nextBeatTime, barIndex, isDownbeat: index % 4 === 0 });

describe("musical enemy arrival", () => {
    test("a reservation remains intangible until the actual following beat, regardless of simulation time", () => {
        const state = createCombat(2026);
        const start = command(0, 0, 0.73);
        onCombatBeat(state, start, origin, right);
        expect(state.enemies).toHaveLength(0);
        expect(state.pendingSpawns).toHaveLength(1);
        const pending = state.pendingSpawns[0]!;
        expect(pending.startTime).toBe(0);
        expect(pending.endTime).toBe(0.73);
        expect(pending.activateBeat).toBe(1);
        // Put the reserved silhouette in a shot's path, then stand inside it.
        pending.enemy.x = 3;
        pending.enemy.z = 0;
        state.projectiles = [];
        fireProjectile(state, origin, right);
        const first = advanceCombat(state, 0.2, origin);
        expect(first.events).toEqual([]);
        expect(state.playerStats.metrics.hits).toBe(0);
        expect(pending.enemy.health).toBe(24);
        expect(state.projectiles).toHaveLength(1);
        advanceCombat(state, 10, { x: 3, z: 0 });
        expect(state.health).toBe(100);
        expect(state.kills).toBe(0);
        expect(state.experience.drops).toEqual([]);
        expect(state.enemies).toHaveLength(0);
        expect(pending.enemy.x).toBe(3);
        expect(pending.enemy.z).toBe(0);
        onCombatBeat(state, start, origin, right); // Duplicate birth is harmless.
        expect(state.pendingSpawns).toHaveLength(1);
        onCombatBeat(state, command(1, 0.73, 1.2), origin, right);
        expect(state.pendingSpawns).toEqual([]);
        expect(state.enemies).toEqual([pending.enemy]);
        advanceCombat(state, 0.01, { x: 3, z: 0 });
        expect(state.health).toBe(85);
    });

    test("pending shooters cannot fire; activation retains their normal bar grace", () => {
        const state = createCombat(2026);
        onCombatBeat(state, command(4, 2, 2.5, 1), origin, right);
        const pending = state.pendingSpawns[0]!;
        expect(pending.enemy.kind).toBe("spinner");
        const heading = pending.enemy.heading;
        const enemyShots = () => state.projectiles.filter(shot => shot.shooterId === pending.enemy.id);
        expect(enemyShots()).toEqual([]);
        onCombatBeat(state, command(5, 2.5, 3, 1), origin, right);
        expect(state.enemies).toEqual([pending.enemy]);
        expect(enemyShots()).toEqual([]);
        expect(pending.enemy.heading).toBe(heading);
        onCombatBeat(state, command(8, 4, 4.5, 2), origin, right);
        expect(enemyShots()).toHaveLength(3);
    });

    test("ricochets cannot target a pending silhouette", () => {
        const state = createCombat(10, { knockbackSpeed: 0 }, { bounces: 1, criticalChance: 0 });
        spawnOnBeat(state, command(4, 2, 2.5, 1), origin);
        const pending = state.pendingSpawns[0]!;
        pending.enemy.x = 6;
        pending.enemy.z = 0;
        const live = createEnemy(state.nextId++, { x: 3, z: 0 }, 0, state.tuning);
        state.enemies.push(live);
        const shot = fireProjectile(state, origin, right)!;
        advanceCombat(state, 0.2, origin);
        expect(shot.waitingForBounce).toBe(true);
        onCombatBeat(state, command(1, 0.5, 1), origin, { x: -1, z: 0 });
        expect(state.projectiles.some(projectile => projectile.id === shot.id)).toBe(false);
        expect(state.pendingSpawns).toHaveLength(1);
        expect(pending.enemy.health).toBe(24);
    });

    test("live enemies and reservations share one hard population cap", () => {
        const state = createCombat(4, { enemyCap: 3, initialWaveSize: 3 });
        const wave = spawnOnBeat(state, command(0, 0, 0.5), origin);
        expect(wave).toHaveLength(3);
        expect(spawnOnBeat(state, command(4, 2, 2.5, 1), origin)).toEqual([]);
        expect(state.enemies.length + state.pendingSpawns.length).toBe(3);
        onCombatBeat(state, command(1, 0.5, 1), origin, right);
        expect(state.pendingSpawns).toEqual([]);
        expect(state.enemies).toHaveLength(3);
        onCombatBeat(state, command(8, 4, 4.5, 2), origin, right);
        expect(state.enemies.length + state.pendingSpawns.length).toBe(3);
    });

    test("final beats and detection gaps do not invent arrival endpoints", () => {
        const state = createCombat(4);
        expect(spawnOnBeat(state, command(0, 0, null), origin)).toEqual([]);
        expect(spawnOnBeat(state, command(4, 2, 12, 1), origin)).toEqual([]);
        expect(state.pendingSpawns).toEqual([]);
        expect(spawnOnBeat(state, command(8, 12, 15, 2), origin)).toHaveLength(1); // Valid 20 BPM.
        state.defeated = true;
        const snapshot = structuredClone(state);
        onCombatBeat(state, command(9, 15, 18, 2), origin, right);
        expect(state).toEqual(snapshot);
        expect(createCombat(4).pendingSpawns).toEqual([]);
    });
});
