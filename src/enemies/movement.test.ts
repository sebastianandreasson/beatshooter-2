import { expect, test } from "bun:test";
import { createCombat, onCombatBeat } from "../combat";
import { createEnemy, enemyVelocity } from "./index";
import { enemyStrideGain, movementBeat } from "./movement";

test("each accepted beat gives one forward stride and a genuine rest at every tempo", () => {
    for (const bpm of [20, 60, 120, 173, 300]) {
        const duration = 60 / bpm, beat = movementBeat(4, 4 + duration);
        expect(enemyStrideGain(beat, 3.99)).toBe(0);
        expect(enemyStrideGain(beat, 4)).toBeGreaterThan(3);
        expect(enemyStrideGain(beat, 4 + duration * 0.6)).toBe(0);
        expect(enemyStrideGain(beat, 4 + duration * 0.99)).toBe(0);
        expect(enemyStrideGain(beat, 40)).toBe(0);
        for (const hz of [30, 60, 144]) {
            let travel = 0, previous = 4;
            for (let tick = 1; previous < 4 + duration; tick++) {
                const position = Math.min(4 + duration, 4 + tick / hz);
                travel += enemyStrideGain(beat, position, position - previous) * (position - previous);
                previous = position;
            }
            // Ordinary tempos retain the previous average pursuit speed.
            // Slow songs cap stride distance instead of teleporting enemies.
            expect(travel).toBeCloseTo(Math.min(0.9, duration), 10);
        }
    }
});

test("a held audio observation cannot repeat travel across extra fixed physics ticks", () => {
    const beat = movementBeat(2, 2.5), dt = 1 / 60;
    const first = enemyStrideGain(beat, 2.1, dt, 2);
    expect(first * dt).toBeGreaterThan(0.25);
    for (let tick = 0; tick < 10; tick++) expect(enemyStrideGain(beat, 2.1, dt, 2.1)).toBe(0);
    const second = enemyStrideGain(beat, 2.2, dt, 2.1);
    const combined = enemyStrideGain(beat, 2.2, dt, 2);
    expect(first + second).toBeCloseTo(combined, 10);
});

test("irregular beats retime the stride; missing or duplicate beats do not restart it", () => {
    const state = createCombat();
    const enemy = createEnemy(1, { x: 12, z: 0 }, 0, state.tuning);
    const accept = (index: number, time: number, nextBeatTime: number) =>
        onCombatBeat(state, { index, barIndex: 0, time, nextBeatTime }, { x: 0, z: 0 }, { x: 0, z: 1 });
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state)).toEqual({ x: 0, z: 0 });
    accept(0, 0, 0.5);
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, 0.1).x).toBeLessThan(0);
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, 0.4).x).toBe(0);
    accept(1, 0.5, 1.3);
    expect(state.movementBeat?.duration).toBeCloseTo(0.8);
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, 0.8).x).toBeLessThan(0);
    accept(1, 0.9, 1.3);
    expect(state.movementBeat?.time).toBe(0.5);
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, 1.1).x).toBe(0);
    accept(2, 1.3, 20);
    expect(state.movementBeat?.duration).toBeCloseTo(0.8);
    expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, 1.4).x).toBeLessThan(0);
    for (const time of [2, 3, 5, 10, 19.9]) {
        expect(enemyVelocity(enemy, { x: 0, z: 0 }, state, time).x).toBe(0);
    }
});

test("pulsed pursuit stops at the player instead of overshooting on a late physics step", () => {
    const state = createCombat();
    state.movementBeat = movementBeat(0, 0.5);
    const enemy = createEnemy(1, { x: 0.1, z: 0 }, 0, state.tuning);
    const velocity = enemyVelocity(enemy, { x: 0, z: 0 }, state, 0.2, 0.2, 0);
    expect(velocity.x).toBe(-0.5);
    expect(velocity.z).toBe(0);
});
