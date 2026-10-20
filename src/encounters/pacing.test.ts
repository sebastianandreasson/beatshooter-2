import { describe, expect, test } from "bun:test";
import { createCombat, onCombatBeat } from "../combat";
import { generateTimeline } from "../rhythm/timeline";
import { ENCOUNTER_IDS, type EncounterId } from "./catalog";
import { campaignProfile, configureEncounter, encounterKillXp } from "./runtime";

/** Clear activated waves so these counts measure releases, not a full arena. */
function measureSpawns(stageIndex: number, bpm = 120, id: EncounterId = "mixed-assault") {
    const duration = 180;
    const combat = createCombat(2026);
    const beats = generateTimeline(duration, bpm);
    configureEncounter(combat, { id, beats, duration, stageIndex, seed: 42, entryNextLevelXp: 54 });
    const quarters = [0, 0, 0, 0];
    let opening = 0;
    for (const beat of beats) {
        const events = onCombatBeat(combat, {
            index: beat.index, barIndex: beat.bar, isDownbeat: beat.downbeat,
            time: beat.time, nextBeatTime: beats[beat.index + 1]?.time ?? null,
        }, { x: 0, z: 0 }, { x: 0, z: 1 });
        const arrivals = events.filter(event => event.kind === "spawn").length;
        if (beat.index === 0) opening = arrivals;
        if (!beat.downbeat) expect(arrivals).toBe(0);
        quarters[Math.min(3, Math.floor(beat.time / duration * 4))]! += arrivals;
        for (const enemy of combat.enemies) encounterKillXp(combat, enemy);
        combat.enemies.length = 0;
        combat.projectiles.length = 0;
    }
    return { opening, quarters, total: quarters.reduce((sum, count) => sum + count, 0) };
}

describe("campaign difficulty ramp", () => {
    test("doubles the opening pressure and steepens the whole-song ramp", () => {
        const opening = campaignProfile(0, 0, 180);
        const ending = campaignProfile(0, 180, 180);
        expect(opening.spawnRate).toBeCloseTo(0.88); // Previously 0.44 enemies/second.
        expect(ending.spawnRate / opening.spawnRate).toBeCloseTo(2.5);
        expect(ending.health / opening.health).toBeCloseTo(1.9);
        expect(ending.speedGain).toBeGreaterThan(opening.speedGain);
        expect(campaignProfile(0, 90, 180)).toEqual(campaignProfile(0, 300, 600));
    });

    test("each cleared song increases pressure and health, including after song ten", () => {
        for (let stage = 1; stage < 20; stage++) {
            for (const progress of [0, 0.5, 1]) {
                const previous = campaignProfile(stage - 1, progress, 1);
                const current = campaignProfile(stage, progress, 1);
                expect(current.spawnRate).toBeGreaterThan(previous.spawnRate);
                expect(current.health).toBeGreaterThan(previous.health);
                expect(current.speedGain).toBeGreaterThan(previous.speedGain);
            }
        }
    });

    test("actual releases more than double the old first-song budget and intensify in every arena", () => {
        const first = measureSpawns(0);
        expect(first.opening).toBe(2);
        // The previous 180-second curve accrued 108.9 ordinary enemies, before release limits.
        expect(first.total).toBeGreaterThan(2 * 108.9);
        for (const id of ENCOUNTER_IDS) {
            const song = measureSpawns(0, 120, id);
            expect(song.quarters[3]!).toBeGreaterThan(song.quarters[0]! * 1.7);
        }
    });

    test("actual releases keep growing across twenty songs without a per-wave plateau", () => {
        let previous = measureSpawns(0).total;
        for (let stage = 1; stage < 20; stage++) {
            const song = measureSpawns(stage);
            expect(song.total).toBeGreaterThan(previous);
            expect(song.quarters[3]!).toBeGreaterThan(song.quarters[0]! * 1.7);
            previous = song.total;
        }
    });

    test("slow and fast songs deliver comparable pressure even late in the campaign", () => {
        for (const id of ["mixed-assault", "swarm-nest"] as const) {
            for (const stage of [0, 4, 9]) {
                const totals = [60, 120, 240].map(bpm => measureSpawns(stage, bpm, id).total);
                expect(Math.min(...totals) / Math.max(...totals)).toBeGreaterThan(0.95);
            }
        }
    });
});
