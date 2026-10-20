import { expect, test } from "bun:test";
import { combatRandom, createCombat } from "../combat";
import {
    createEnemy, enemyKindForSpawn, enemyVelocity, findArenaSpawnPosition, findSpawnPosition, waveSize,
} from "./index";

test("spawn cadence introduces each silhouette and keeps larger waves varied", () => {
    expect(Array.from({ length: 6 }, (_, bar) => enemyKindForSpawn(bar, 0))).toEqual([
        "chaser", "spinner", "ranger", "chaser", "spinner", "ranger",
    ]);
    expect(Array.from({ length: 5 }, (_, slot) => enemyKindForSpawn(12, slot))).toEqual([
        "chaser", "spinner", "ranger", "chaser", "spinner",
    ]);
    const { tuning } = createCombat();
    expect(createEnemy(1, { x: 3, z: 4 }, 0, tuning).kind).toBe("chaser");
    const spinner = createEnemy(2, { x: 3, z: 4 }, 1, tuning, "spinner", Math.PI / 3);
    expect(spinner.kind).toBe("spinner");
    expect(spinner.heading).toBe(Math.PI / 3);
});

test("pursuit is planar, normalized, and has a bounded musical speed increase", () => {
    const state = createCombat();
    const enemy = createEnemy(1, { x: 4, z: 4 }, 0, state.tuning);
    const initial = enemyVelocity(enemy, { x: 0, z: 0 }, state);
    expect(Math.hypot(initial.x, initial.z)).toBeCloseTo(state.tuning.enemySpeed);
    expect(initial.x).toBeLessThan(0);
    expect(initial.z).toBeLessThan(0);
    state.lastBarIndex = 1000;
    const pressured = enemyVelocity(enemy, { x: 0, z: 0 }, state);
    expect(Math.hypot(pressured.x, pressured.z)).toBeCloseTo(state.tuning.enemyMaxSpeed);
    expect(enemyVelocity(enemy, { x: 4, z: 4 }, state)).toEqual({ x: 0, z: 0 });
    state.defeated = true;
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state)).toEqual({ x: 0, z: 0 });
});

test("wave sizes follow bar sections and are capped", () => {
    const { tuning } = createCombat();
    expect(waveSize(0, tuning)).toBe(1);
    expect(waveSize(11, tuning)).toBe(1);
    expect(waveSize(12, tuning)).toBe(2);
    expect(waveSize(400, tuning)).toBe(5);
});

test("repeated unsafe random candidates fall back to a safe corner", () => {
    const { tuning } = createCombat();
    const player = { x: -17, z: -17 };
    const position = findSpawnPosition(player, tuning, () => 0)!;
    expect(Math.hypot(position.x - player.x, position.z - player.z)).toBeGreaterThan(7);
    expect(position).toEqual({ x: 17, z: 17 });
});

test("arena spawns are seeded, bounded, safe, and include interior positions", () => {
    const sample = () => {
        const state = createCombat(2026);
        const player = { x: 3, z: -5 };
        return Array.from({ length: 100 }, () => {
            const point = findArenaSpawnPosition(player, state.tuning, () => combatRandom(state))!;
            expect(Math.abs(point.x)).toBeLessThanOrEqual(17);
            expect(Math.abs(point.z)).toBeLessThanOrEqual(17);
            expect(Math.hypot(point.x - player.x, point.z - player.z)).toBeGreaterThanOrEqual(7);
            return point;
        });
    };
    const first = sample();
    expect(first).toEqual(sample());
    expect(first.some((point) => Math.abs(point.x) < 12 && Math.abs(point.z) < 12)).toBe(true);
});

test("arena spawns exhaust bounded retries before a safe fallback or no spawn", () => {
    const state = createCombat();
    let calls = 0;
    const unsafeCenter = () => { calls++; return 0.5; };
    expect(findArenaSpawnPosition({ x: 0, z: 0 }, state.tuning, unsafeCenter)).toEqual({
        x: -17, z: -17,
    });
    expect(calls).toBe(48);
    expect(findArenaSpawnPosition({ x: -17, z: -17 }, state.tuning, () => 0)).toEqual({
        x: 17, z: 17,
    });
    state.tuning.spawnSafetyRadius = 50;
    calls = 0;
    expect(findArenaSpawnPosition({ x: 0, z: 0 }, state.tuning, unsafeCenter)).toBeUndefined();
    expect(calls).toBe(48);
});

test("rangers approach, settle at firing distance, and resume pursuit when the player leaves", () => {
    const state = createCombat(1, { rangerStopDistance: 6 });
    const ranger = createEnemy(1, { x: 12, z: 0 }, 0, state.tuning, "ranger");
    const player = { x: 0, z: 0 };
    expect(enemyVelocity(ranger, player, state)).toEqual({ x: -2.5, z: 0 });
    for (let frame = 0; frame < 600; frame++) {
        const velocity = enemyVelocity(ranger, player, state);
        ranger.x += velocity.x / 60;
        ranger.z += velocity.z / 60;
        expect(Math.hypot(ranger.x, ranger.z)).toBeGreaterThanOrEqual(6);
    }
    expect(ranger.x).toBeCloseTo(6, 5);
    expect(ranger.z).toBe(0);
    ranger.x = 6;
    expect(enemyVelocity(ranger, player, state)).toEqual({ x: 0, z: 0 });
    ranger.x = 4;
    expect(enemyVelocity(ranger, player, state)).toEqual({ x: 0, z: 0 });
    expect(enemyVelocity(ranger, { x: -8, z: 0 }, state).x).toBeLessThan(0);
    ranger.health = 0;
    expect(enemyVelocity(ranger, { x: -8, z: 0 }, state)).toEqual({ x: 0, z: 0 });
});

test("stationary spinners and stopped rangers still receive decaying knockback", () => {
    const state = createCombat();
    for (const kind of ["spinner", "ranger"] as const) {
        const enemy = createEnemy(1, { x: 3, z: 0 }, 0, state.tuning, kind);
        expect(enemyVelocity(enemy, { x: 0, z: 0 }, state)).toEqual({ x: 0, z: 0 });
        enemy.knockbackX = 7;
        enemy.knockbackZ = -3;
        enemy.knockbackStartedAt = 1;
        enemy.knockbackUntil = 1.45;
        state.time = 1;
        expect(enemyVelocity(enemy, { x: 0, z: 0 }, state)).toEqual({ x: 7, z: -3 });
        state.time = 1.2;
        const fading = enemyVelocity(enemy, { x: 0, z: 0 }, state);
        expect(fading.x).toBeGreaterThan(0);
        expect(fading.x).toBeLessThan(7);
        expect(fading.z).toBeGreaterThan(-3);
        expect(fading.z).toBeLessThan(0);
        state.time = 1.45;
        expect(enemyVelocity(enemy, { x: 0, z: 0 }, state)).toEqual({ x: 0, z: 0 });
    }
    const spinner = createEnemy(2, { x: 15, z: 15 }, 0, state.tuning, "spinner");
    expect(enemyVelocity(spinner, { x: 0, z: 0 }, state)).toEqual({ x: 0, z: 0 });
});
