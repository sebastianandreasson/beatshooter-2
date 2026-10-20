import { expect, test } from "bun:test";
import type { SongSection } from "../analysis/sections";
import { createEnemy } from "../enemies";
import { advanceSectionDifficulty, scaleEnemyHealth } from "./difficulty";
import { createCombat, spawnOnBeat } from "./index";

const sections: SongSection[] = [
    { start: 0, end: 2.25, label: "intro" },
    { start: 2.25, end: 5, label: "verse" },
    { start: 5, end: 9, label: "verse" },
    { start: 9, end: 20, label: "chorus" },
];
const origin = { x: 0, z: 0 };

test("each actual section scales alive, pending and future enemies, including repeated labels", () => {
    const combat = createCombat(3, { enemyHealth: 100 });
    const live = createEnemy(combat.nextId++, { x: 5, z: 5 }, 0, combat.tuning);
    combat.enemies.push(live);
    live.health = 50;
    const [pending] = spawnOnBeat(combat, { index: 0, barIndex: 0 }, origin);
    for (const position of [-1, 0, 2.249]) advanceSectionDifficulty(combat, sections, position);
    expect(live.health).toBe(50);
    expect(live.maxHealth).toBe(100);
    advanceSectionDifficulty(combat, sections, 2.25);
    expect(live.health).toBe(55);
    expect(live.maxHealth).toBe(110);
    expect(pending!.health).toBe(110);
    expect(pending!.maxHealth).toBe(110);
    const held = structuredClone(combat);
    for (const position of [2.25, 2.25, 3, 4.99, 1]) advanceSectionDifficulty(combat, sections, position);
    expect(combat).toEqual(held);
    advanceSectionDifficulty(combat, sections, 5);
    expect(live.maxHealth).toBe(121);
    expect(live.health).toBe(61);
    expect(pending!.health).toBe(121);
    const [future] = spawnOnBeat(combat, { index: 4, barIndex: 1 }, origin);
    expect(future!.health).toBe(121);
    expect(future!.maxHealth).toBe(live.maxHealth);
    expect(future!.baseHealth).toBe(100);
    expect(combat.tuning.enemyHealth).toBe(100);
});

test("skipped boundaries compound once; missing sections, pause observations and new runs stay bounded", () => {
    const combat = createCombat();
    const enemy = createEnemy(1, origin, 0, combat.tuning);
    combat.enemies.push(enemy);
    advanceSectionDifficulty(combat, undefined, 200);
    advanceSectionDifficulty(combat, sections, NaN);
    expect(enemy.maxHealth).toBe(24);
    advanceSectionDifficulty(combat, sections, 19);
    expect(combat.healthSection).toBe(3);
    expect(enemy.maxHealth).toBe(32); // round(24 × 1.1³), even if intermediate frames were skipped.
    expect(enemy.health).toBe(32);
    for (let i = 0; i < 100; i++) advanceSectionDifficulty(combat, sections, 19);
    expect(enemy.maxHealth).toBe(32);
    advanceSectionDifficulty(combat, sections, 200); // End of track is not another section.
    expect(enemy.maxHealth).toBe(32);
    expect(createCombat().healthSection).toBe(0);
    expect(createEnemy(1, origin, 0, createCombat().tuning).maxHealth).toBe(24);
});

test("capacities avoid repeated rounding, preserve wounded enemies and never resurrect a dead target", () => {
    const combat = createCombat();
    for (const kind of ["chaser", "spinner", "ranger"] as const) {
        const stepped = createEnemy(1, origin, 0, combat.tuning, kind);
        const skipped = createEnemy(2, origin, 0, combat.tuning, kind);
        for (let section = 1; section <= 10; section++) scaleEnemyHealth(stepped, section);
        scaleEnemyHealth(skipped, 10);
        expect(stepped.maxHealth).toBe(skipped.maxHealth);
        stepped.health = 0;
        scaleEnemyHealth(stepped, 11);
        expect(stepped.health).toBe(0);
        skipped.health = 1;
        scaleEnemyHealth(skipped, 11);
        expect(skipped.health).toBeGreaterThan(0);
        expect(skipped.health).toBeLessThan(3);
        scaleEnemyHealth(skipped, 1500);
        expect(Number.isSafeInteger(skipped.maxHealth)).toBe(true);
        expect(Number.isSafeInteger(skipped.health)).toBe(true);
    }
});
