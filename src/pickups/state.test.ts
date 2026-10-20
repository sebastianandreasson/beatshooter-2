import { expect, test } from "bun:test";
import { advancePickups, createPickups, PICKUP_KINDS } from "./state";

test("four randomized, reachable pickups span a song and always include every type", () => {
    for (const duration of [1, 12, 72, 180, 600]) {
        for (let seed = 0; seed < 40; seed++) {
            const state = createPickups(seed, duration);
            expect(state.schedule).toHaveLength(4);
            expect(new Set(state.schedule.map(drop => drop.kind))).toEqual(new Set(PICKUP_KINDS));
            for (const [i, drop] of state.schedule.entries()) {
                expect(drop.spawnAt / duration).toBeGreaterThanOrEqual(0.12 + i * 0.2);
                expect(drop.spawnAt / duration).toBeLessThan(0.22 + i * 0.2);
                expect(Math.abs(drop.x)).toBeLessThanOrEqual(13.5);
                expect(Math.abs(drop.z)).toBeLessThanOrEqual(13.5);
            }
            expect(createPickups(seed, duration)).toEqual(state);
        }
    }
    expect(createPickups(1, 180).schedule).not.toEqual(createPickups(2, 180).schedule);
    expect(createPickups(1).schedule).toEqual([]);
});

test("song-clock spawning is independent of beat gaps, fixed ticks and backward observations", () => {
    const state = createPickups(42, 180);
    advancePickups(state, state.schedule[0]!.spawnAt - 0.001);
    expect(state.drops).toEqual([]);
    advancePickups(state, state.schedule[0]!.spawnAt);
    expect(state.drops).toHaveLength(1);
    for (let i = 0; i < 50; i++) advancePickups(state, state.position);
    advancePickups(state, 0);
    advancePickups(state, NaN);
    expect(state.drops).toHaveLength(1);
    state.drops.length = 0;
    advancePickups(state, 180);
    expect(state.drops).toHaveLength(3);
    advancePickups(state, 1800);
    expect(state.drops).toHaveLength(3);
    expect(state.nextSpawn).toBe(4);
});
