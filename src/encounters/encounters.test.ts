import { describe, expect, test } from "bun:test";
import { advanceCombat, createCombat, fireProjectile, onCombatBeat, type CombatState } from "../combat";
import { advanceSectionDifficulty } from "../combat/difficulty";
import { createEnemy, enemyVelocity } from "../enemies";
import { generateTimeline } from "../rhythm/timeline";
import { setPlayerStatModifier } from "../player-stats";
import { ENCOUNTER_IDS, encounterReward, generateEncounterOffers, type EncounterId } from "./catalog";
import { campaignProfile, configureEncounter, encounterKillXp, stopEncounter } from "./runtime";

function setup(id: EncounterId, bpm = 120, duration = 60, stageIndex = 0, cap = 100) {
    const combat = createCombat(2026, { enemyCap: cap });
    const beats = generateTimeline(duration, bpm);
    const encounter = configureEncounter(combat, { id, beats, duration, stageIndex, seed: 42, entryNextLevelXp: 54 });
    return { combat, encounter, beats };
}
function beat(combat: CombatState, index: number, player = { x: 0, z: 0 }) {
    const authored = combat.encounter!.beats[index]!;
    return onCombatBeat(combat, {
        index, barIndex: authored.bar, isDownbeat: authored.downbeat,
        time: authored.time, nextBeatTime: combat.encounter!.beats[index + 1]?.time ?? null,
    }, player, { x: 0, z: 1 });
}

test("offers preserve three distinct choices, a lower-pressure option, introductions and deterministic replay", () => {
    for (let seed = 0; seed < 40; seed++) {
        const rows = generateEncounterOffers(seed, 10);
        expect(rows).toEqual(generateEncounterOffers(seed, 10));
        for (let index = 0; index < rows.length; index++) {
            expect(new Set(rows[index]).size).toBe(3);
            expect(rows[index]).toContain("mixed-assault");
            if (index < 2) expect(rows[index]!.every(id => !["elite-hunt", "pulse-grid"].includes(id))).toBe(true);
            if (index) expect([...rows[index]!].sort()).not.toEqual([...rows[index - 1]!].sort());
        }
    }
    expect(generateEncounterOffers(42, 10)).not.toEqual(generateEncounterOffers(99, 10));
});

test("success reward uses ordinary XP only, captures its entry cap, and requires the elite kill", () => {
    expect(encounterReward("mixed-assault", 200, 54, false)).toBe(0);
    for (const id of ["swarm-nest", "marksman-outpost", "spinner-crossfire"] as const) {
        expect(encounterReward(id, 200, 54, false)).toBe(20);
        expect(encounterReward(id, 400, 54, false)).toBe(27);
    }
    expect(encounterReward("pulse-grid", 100, 54, false)).toBe(20);
    expect(encounterReward("pulse-grid", 400, 54, false)).toBe(27);
    expect(encounterReward("elite-hunt", 400, 54, false)).toBe(0);
    expect(encounterReward("elite-hunt", 0, 54, true)).toBe(27);
    expect(() => encounterReward("swarm-nest", NaN, 54, false)).toThrow();
});

describe("bounded campaign pressure", () => {
    test("stage and normalized progress bound health/speed independently of section and bar counts", () => {
        const { combat, encounter } = setup("mixed-assault", 120, 600, 9);
        const target = createEnemy(999, { x: 10, z: 0 }, 0, combat.tuning);
        combat.enemies.push(target);
        advanceSectionDifficulty(combat, undefined, 300);
        expect(target.maxHealth).toBe(Math.round(24 * campaignProfile(9, 0.5, 1).health));
        expect(encounter.enemySpeed).toBeLessThanOrEqual(3.6);
        const capacity = target.maxHealth;
        const manySections = Array.from({ length: 1000 }, (_, i) => ({
            start: i / 10, end: (i + 1) / 10, label: "chorus" as const,
        }));
        advanceSectionDifficulty(combat, manySections, 300);
        expect(target.maxHealth).toBe(capacity);
        advanceSectionDifficulty(combat, manySections, 10_000);
        expect(target.maxHealth).toBe(Math.round(24 * campaignProfile(9, 1, 1).health));
        expect(encounter.enemySpeed).toBeLessThanOrEqual(3.6);
    });

    test("fast and slow tracks accrue comparable elapsed-time budgets released only on downbeats", () => {
        const totals: number[] = [];
        for (const bpm of [60, 120, 240]) {
            const { combat, encounter, beats } = setup("mixed-assault", bpm);
            let spawned = 0;
            for (const authored of beats) {
                const events = beat(combat, authored.index);
                const arrivals = events.filter(event => event.kind === "spawn").length;
                if (!authored.downbeat) expect(arrivals).toBe(0);
                spawned += arrivals;
                // Remove the preceding wave to compare pressure, not population saturation.
                combat.enemies.length = 0;
                combat.projectiles.length = 0;
                for (const id of [...encounter.enemies.keys()]) {
                    if (!combat.pendingSpawns.some(spawn => spawn.enemy.id === id)) encounter.enemies.delete(id);
                }
            }
            totals.push(spawned);
        }
        // Slow songs leave up to three more seconds after their last downbeat;
        // allow that unreleased tail at the stronger end-of-song spawn rate.
        expect(Math.min(...totals) / Math.max(...totals)).toBeGreaterThan(0.9);
    });

    test("many tiny difficulty changes preserve wounds without accumulated integer-rounding healing", () => {
        const { combat, encounter } = setup("mixed-assault", 120, 600, 9);
        beat(combat, 0);
        const enemy = combat.pendingSpawns[0]!.enemy;
        enemy.health = Math.floor(enemy.maxHealth / 2);
        const fraction = enemy.health / enemy.maxHealth;
        for (let position = 1; position <= 600; position++) advanceSectionDifficulty(combat, undefined, position);
        expect(enemy.health).toBe(Math.round(enemy.maxHealth * fraction));
        enemy.health = 0;
        advanceSectionDifficulty(combat, undefined, 600);
        expect(enemy.health).toBe(0);
        expect(encounter.enemies.size).toBe(2);
    });

    test("all six arenas honor population, projectile and warning caps even in late songs", () => {
        for (const id of ENCOUNTER_IDS) {
            const { combat, encounter, beats } = setup(id, 300, 50, 9, 7);
            for (const authored of beats) {
                beat(combat, authored.index);
                expect(combat.enemies.length + combat.pendingSpawns.length).toBeLessThanOrEqual(7);
                expect(combat.projectiles.length).toBeLessThanOrEqual(combat.tuning.projectileCap);
                expect(encounter.rangerWarnings.size).toBeLessThanOrEqual(6);
                expect(encounter.hazards.grid?.tiles.length ?? 0).toBeLessThanOrEqual(8);
            }
        }
    });

    test("a skipped chart interval discards budget and arrivals instead of releasing a catch-up wave", () => {
        const { combat, encounter } = setup("mixed-assault");
        beat(combat, 0);
        expect(combat.pendingSpawns).toHaveLength(2);
        beat(combat, 12);
        expect(combat.pendingSpawns).toHaveLength(0);
        expect(combat.enemies).toHaveLength(0);
        expect(encounter.spawnBudget).toBe(0);
    });
});

test("Swarm Nest doubles weak chasers while dividing one ordinary wave's XP", () => {
    const mixed = setup("mixed-assault"), swarm = setup("swarm-nest");
    beat(mixed.combat, 0);
    beat(swarm.combat, 0);
    expect(mixed.combat.pendingSpawns).toHaveLength(2);
    expect(swarm.combat.pendingSpawns).toHaveLength(4);
    expect(swarm.combat.pendingSpawns.every(spawn => spawn.enemy.kind === "chaser")).toBe(true);
    expect(swarm.combat.pendingSpawns.every(spawn => spawn.enemy.health < 24)).toBe(true);
    const mixedXp = mixed.combat.pendingSpawns.reduce((sum, spawn) => sum + encounterKillXp(mixed.combat, spawn.enemy), 0);
    const swarmXp = swarm.combat.pendingSpawns.reduce((sum, spawn) => sum + encounterKillXp(swarm.combat, spawn.enemy), 0);
    expect(swarmXp).toBe(mixedXp);
});

test("Marksman warnings lock muzzle and aim; the strike uses that line after the player moves", () => {
    const { combat, encounter } = setup("marksman-outpost", 300);
    const enemy = createEnemy(999, { x: 0, z: -5 }, -1, combat.tuning, "ranger");
    combat.enemies.push(enemy);
    encounter.spawnBudget = 0;
    beat(combat, 0);
    const warning = structuredClone(encounter.rangerWarnings.get(enemy.id))!;
    expect(warning.strikeTime - warning.startTime).toBeGreaterThanOrEqual(1);
    expect(enemyVelocity(enemy, { x: 9, z: -5 }, combat, 0.5)).toEqual({ x: 0, z: 0 });
    for (let index = 1; index <= warning.strikeIndex; index++) beat(combat, index, { x: 6, z: -5 });
    const shot = combat.projectiles.find(item => item.shooterId === enemy.id)!;
    expect(shot).toBeDefined();
    expect(shot.velocityX).toBe(0);
    expect(shot.velocityZ).toBeGreaterThan(0);
    expect(shot.previousX).toBe(warning.origin.x);
    expect(combat.projectiles.filter(item => item.shooterId === enemy.id)).toHaveLength(1);
    beat(combat, warning.strikeIndex, { x: -6, z: -5 });
    expect(combat.projectiles.filter(item => item.shooterId === enemy.id)).toHaveLength(1);
});

test("Crossfire groups alternate complete three-ray volleys rather than firing together", () => {
    const { combat, encounter } = setup("spinner-crossfire");
    encounter.spawnBudget = 0;
    for (let group = 0; group < 2; group++) {
        const enemy = createEnemy(900 + group, { x: group ? 10 : -10, z: 10 }, -1, combat.tuning, "spinner");
        combat.enemies.push(enemy);
        encounter.enemies.set(enemy.id, { group, xp: 10, elite: false });
    }
    beat(combat, 0);
    expect(combat.projectiles.filter(shot => shot.shooterId === 900)).toHaveLength(3);
    expect(combat.projectiles.filter(shot => shot.shooterId === 901)).toHaveLength(0);
    for (let index = 1; index <= 4; index++) beat(combat, index);
    expect(combat.projectiles.filter(shot => shot.shooterId === 900)).toHaveLength(3);
    expect(combat.projectiles.filter(shot => shot.shooterId === 901)).toHaveLength(3);
});

test("Elite Hunt warns for a bar, activates once, and records a bonus only after an actual kill", () => {
    const { combat, encounter } = setup("elite-hunt");
    for (let index = 0; index <= 24; index++) beat(combat, index);
    const pending = combat.pendingSpawns.find(spawn => spawn.enemy.id === encounter.eliteId)!;
    expect(pending).toBeDefined();
    expect(pending.endTime - pending.startTime).toBeGreaterThanOrEqual(2);
    expect(pending.enemy.radius).toBeCloseTo(combat.tuning.enemyRadius * 1.5);
    expect(pending.enemy.maxHealth).toBeGreaterThanOrEqual(96);
    expect(combat.enemies.some(enemy => enemy.id === encounter.eliteId)).toBe(false);
    for (let index = 25; index <= pending.activateBeat; index++) beat(combat, index);
    const elite = combat.enemies.find(enemy => enemy.id === encounter.eliteId)!;
    expect(elite).toBeDefined();
    expect(encounter.eliteDefeated).toBe(false);
    for (let index = pending.activateBeat + 1; index <= 32; index++) beat(combat, index);
    const firstVolley = combat.projectiles.filter(shot => shot.shooterId === elite.id);
    expect(firstVolley).toHaveLength(6);
    const angle = Math.atan2(firstVolley[0]!.velocityX, firstVolley[0]!.velocityZ);
    combat.projectiles.length = 0;
    for (let index = 33; index <= 40; index++) beat(combat, index);
    const nextVolley = combat.projectiles.filter(shot => shot.shooterId === elite.id);
    expect(nextVolley).toHaveLength(6);
    const difference = Math.atan2(nextVolley[0]!.velocityX, nextVolley[0]!.velocityZ) - angle;
    expect(Math.atan2(Math.sin(difference), Math.cos(difference))).toBeCloseTo(Math.PI / 6);
    combat.projectiles.length = 0;
    combat.enemies = [elite];
    elite.x = 0; elite.z = 3; elite.health = 1;
    fireProjectile(combat, { x: 0, z: 0 }, { x: 0, z: 1 });
    const killed = advanceCombat(combat, 0.1, { x: 0, z: 0 });
    expect(killed.killedIds).toContain(elite.id);
    expect(encounter.eliteDefeated).toBe(true);
    expect(encounter.ordinaryXp).toBe(10);
    expect(encounterReward("elite-hunt", encounter.ordinaryXp, 54, encounter.eliteDefeated)).toBe(27);
});

test("floor strikes share shield and damage immunity, are consumed once, and stop during settlement", () => {
    const { combat, encounter } = setup("pulse-grid");
    for (let index = 0; index <= 12; index++) beat(combat, index);
    const tile = encounter.hazards.pendingStrikes[0]![0]!;
    combat.enemies.length = 0; combat.projectiles.length = 0;
    const hit = advanceCombat(combat, 1 / 60, tile);
    expect(hit.playerDamaged).toBe(true);
    expect(combat.health).toBe(85);
    expect(encounter.hazards.pendingStrikes).toHaveLength(0);
    advanceCombat(combat, 1, tile);
    expect(combat.health).toBe(85);
    encounter.hazards.pendingStrikes.push([tile], [tile]);
    setPlayerStatModifier(combat.playerStats, "test-shield", { add: { regenerativeShield: 1 } });
    advanceCombat(combat, 1, tile);
    expect(combat.health).toBe(85);
    expect(combat.shieldBlocks).toBe(1);
    encounter.hazards.pendingStrikes.push([tile]);
    stopEncounter(combat);
    expect(encounter.hazards.pendingStrikes).toHaveLength(0);
    expect(encounter.hazards.grid).toBeUndefined();
    expect(advanceCombat(combat, 10, tile).playerDamaged).toBe(false);
});

test("ten full song lifecycles retain bounded encounter state and discard all transient warnings at boundaries", () => {
    let totalSpawns = 0;
    for (let stageIndex = 0; stageIndex < 10; stageIndex++) {
        const { combat, encounter, beats } = setup(ENCOUNTER_IDS[stageIndex % ENCOUNTER_IDS.length]!, 180, 180, stageIndex);
        for (const authored of beats) {
            totalSpawns += beat(combat, authored.index).filter(event => event.kind === "spawn").length;
            expect(encounter.enemies.size).toBeLessThanOrEqual(combat.tuning.enemyCap);
            expect(encounter.hazards.pendingStrikes.length).toBeLessThanOrEqual(1);
            expect(encounter.rangerWarnings.size).toBeLessThanOrEqual(6);
            expect(combat.projectiles.length).toBeLessThanOrEqual(combat.tuning.projectileCap);
            if (authored.index % 16 === 0) {
                // A crowd-control build clears its current live targets. Exercise
                // the same per-kill bookkeeping used by swept projectile damage.
                for (const enemy of combat.enemies) encounterKillXp(combat, enemy);
                combat.enemies.length = 0;
                combat.projectiles.length = 0;
            }
        }
        stopEncounter(combat);
        expect(encounter.rangerWarnings.size).toBe(0);
        expect(encounter.hazards.grid).toBeUndefined();
        expect(encounter.hazards.pendingStrikes).toHaveLength(0);
        const next = createCombat();
        expect(next.encounter).toBeUndefined();
        expect(next.pendingSpawns).toHaveLength(0);
    }
    expect(totalSpawns).toBeGreaterThan(1000);
});
