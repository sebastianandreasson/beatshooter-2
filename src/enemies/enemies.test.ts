import { expect, test } from "bun:test";
import { createCombat } from "../combat";
import { createEnemy, enemyVelocity, findSpawnPosition, waveSize } from "./index";

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
