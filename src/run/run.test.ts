import { describe, expect, test } from "bun:test";
import { advanceExperience, dropExperience } from "../experience/state";
import { setPlayerStatModifier } from "../player-stats";
import { chooseUpgrade, describeUpgrade, prepareUpgradeChoices, queueUpgradeLevels, type UpgradeId } from "../upgrades";
import type { CombatState } from "../combat";
import {
    abandonRun, chooseRunUpgrade, createRun, defeatRun, restoreRunCombat, selectRunArena,
    settleRunSong, validateRunRecord, type RunRecord, type RunSong,
} from "./model";
import { experienceAtTotal, restoreProgression, snapshotProgression } from "./progression";

export function songFixture(count = 2): RunSong[] {
    return Array.from({ length: count }, (_, i) => ({
        slotId: `slot-${i}`, trackId: "a".repeat(64), audioHash: "a".repeat(64), chartId: "chart-a",
        title: "Repeated test song", artist: "Test", duration: 30, timing: "manual" as const,
    }));
}
export function runFixture(count = 2, id = "run-a"): RunRecord {
    return createRun({ id, title: "Test playlist", songs: songFixture(count), seed: 123, now: 100 });
}
function pick(run: RunRecord): RunRecord {
    const upgrades = restoreRunCombat(run).upgrades;
    return chooseRunUpgrade(run, upgrades.choices[0]!.id, upgrades.offeredLevel);
}
export function activeFixture(count = 2): RunRecord {
    return selectRunArena(pick(runFixture(count)), "mixed-assault");
}
function earn(combat: CombatState, amount: number): void {
    dropExperience(combat.experience, { x: 0, z: 0 }, amount);
    advanceExperience(combat.experience, 0.01, { x: 0, z: 0 });
    queueUpgradeLevels(combat.upgrades, combat.experience.level);
    prepareUpgradeChoices(combat);
}
function forceChoice(combat: CombatState, id: UpgradeId): void {
    combat.upgrades.choices = [describeUpgrade(id, combat.upgrades.ranks[id], combat.playerStats.effective)];
    expect(chooseUpgrade(combat, id, combat.time)).toBe(true);
}

describe("persistent run progression", () => {
    test("starting choice and frozen playlist survive reload exactly once", () => {
        const songs = songFixture();
        const run = createRun({ id: "immutable", title: "Playlist", songs, seed: 8, now: 0 });
        songs[0]!.title = "Changed outside run";
        expect(run.songs[0]!.title).toBe("Repeated test song");
        expect(Object.isFrozen(run.songs[0])).toBe(true);
        const reload = validateRunRecord(JSON.parse(JSON.stringify(run)));
        expect(restoreRunCombat(reload).upgrades).toEqual(restoreRunCombat(run).upgrades);
        const selected = pick(reload);
        expect(selected.status).toBe("choosing-arena");
        expect(selected.initialChoiceCompleted).toBe(true);
        expect(restoreRunCombat(selected).upgrades.pending).toBe(0);
        expect(() => chooseRunUpgrade(selected, run.progression.upgrades.offerIds[0]!, 1)).toThrow();
    });

    test("ten-song route carries only progression, banks drops once and resolves every intermission pick", () => {
        let run = pick(runFixture(10));
        let totalEarned = 0;
        for (let songIndex = 0; songIndex < 10; songIndex++) {
            expect(run.songIndex).toBe(songIndex);
            const mapBefore = run.map;
            run = selectRunArena(run, "mixed-assault");
            const combat = restoreRunCombat(run);
            expect(combat.health).toBe(combat.playerStats.effective.maxHealth);
            expect(combat.enemies).toEqual([]);
            expect(combat.experience.drops).toEqual([]);
            expect(combat.lastBeatIndex).toBe(-1);
            expect(combat.time).toBe(0);
            expect(combat.upgrades.pending).toBe(0);
            earn(combat, 20);
            dropExperience(combat.experience, { x: 16, z: 16 }, 20);
            combat.health = 1;
            combat.score += 200;
            combat.kills += 2;
            combat.time = 30;
            const settled = settleRunSong(run, combat, { songIndex, ordinaryXp: 40 });
            expect(settleRunSong(settled, combat, { songIndex })).toBe(settled);
            totalEarned += 40;
            expect(settled.progression.experience.totalXp).toBe(totalEarned);
            expect(settled.progression.score).toBe((songIndex + 1) * 200);
            expect(settled.route[songIndex]!.bankedXp).toBe(20);
            expect(settled.map).toEqual(mapBefore);
            run = validateRunRecord(JSON.parse(JSON.stringify(settled)));
            while (run.status === "intermission") {
                const previousOffer = run.progression.upgrades.offerIds;
                const previousPending = run.progression.upgrades.pending;
                expect(validateRunRecord(structuredClone(run)).progression.upgrades.offerIds).toEqual(previousOffer);
                run = pick(run);
                expect(run.progression.upgrades.pending).toBe(previousPending - 1);
            }
        }
        expect(run.status).toBe("completed");
        expect(run.route).toHaveLength(10);
        expect(run.songIndex).toBe(10);
        expect(Object.values(run.progression.upgrades.ranks).reduce((a, b) => a + b, 0) +
            run.progression.upgrades.pending).toBe(run.progression.experience.level);
        expect(() => selectRunArena(run, "mixed-assault")).toThrow();
    });

    test("replaying current song rolls back its XP, picks, score, RNG and transient state", () => {
        const run = activeFixture();
        const original = restoreRunCombat(run);
        const live = restoreRunCombat(run);
        earn(live, 300);
        const first = live.upgrades.choices[0]!.id;
        chooseUpgrade(live, first, 19);
        live.score = 10000;
        live.kills = 50;
        live.randomState = 99;
        live.time = 19;
        live.health = 1;
        live.invulnerableUntil = 20;
        live.regenerationDueAt = 24;
        live.shieldRechargeAt = 40;
        live.lastBeatIndex = 38;
        const resumed = restoreRunCombat(validateRunRecord(JSON.parse(JSON.stringify(run))));
        expect(resumed).toEqual(original);
        expect(run.progression.experience.totalXp).toBe(0);
        expect(run.progression.upgrades.randomState).toBe(original.upgrades.randomState);
    });

    test("restore rebuilds fractional and special modifiers once; song effects and deadlines disappear", () => {
        const live = restoreRunCombat(runFixture());
        forceChoice(live, "regenerative-shield");
        earn(live, 180);
        forceChoice(live, "projectiles");
        forceChoice(live, "homing");
        forceChoice(live, "regeneration");
        // Any remaining choices get a canonical persisted offer.
        prepareUpgradeChoices(live);
        setPlayerStatModifier(live.playerStats, "permanent:test", { multiply: { damageMultiplier: 1.25 } });
        setPlayerStatModifier(live.playerStats, "song:challenge", { add: { maxHealth: 1000 } });
        live.health = 12;
        live.shieldRechargeAt = 50;
        live.shieldLastBlockedAt = 25;
        live.regenerationDueAt = 55;
        live.shieldBlocks = 4;
        const saved = snapshotProgression(live);
        const restored = restoreProgression(saved, 55);
        expect(restored.playerStats.effective.damageMultiplier).toBeCloseTo(0.9 * 1.25);
        expect(restored.playerStats.effective.regenerativeShield).toBe(1);
        expect(restored.playerStats.effective.homing).toBe(1);
        expect(restored.playerStats.effective.healthRegen).toBe(2);
        expect(restored.playerStats.effective.maxHealth).toBe(100);
        expect(restored.playerStats.modifiers["song:challenge"]).toBeUndefined();
        expect(restored.health).toBe(100);
        expect(restored.shieldRechargeAt).toBe(-Infinity);
        expect(restored.shieldLastBlockedAt).toBe(-Infinity);
        expect(restored.regenerationDueAt).toBe(5);
        expect(restored.shieldBlocks).toBe(4);
        expect(snapshotProgression(restored)).toEqual(saved);
    });

    test("clear preserves already offered cards and puts newly earned levels behind them", () => {
        const run = activeFixture();
        const combat = restoreRunCombat(run);
        earn(combat, 36);
        const offer = combat.upgrades.choices.map(c => c.id);
        const randomState = combat.upgrades.randomState;
        dropExperience(combat.experience, { x: 10, z: 10 }, 200);
        const next = settleRunSong(run, combat, { songIndex: 0 });
        expect(next.status).toBe("intermission");
        expect(next.progression.upgrades.offerIds).toEqual(offer);
        expect(next.progression.upgrades.randomState).toBe(randomState);
        expect(next.progression.upgrades.pending).toBeGreaterThan(1);
        const picked = chooseRunUpgrade(next, offer[0]!, next.progression.upgrades.offeredLevel);
        expect(picked.revision).toBe(next.revision + 1);
        expect(picked.progression.upgrades.pending).toBe(next.progression.upgrades.pending - 1);
        expect(validateRunRecord(structuredClone(picked))).toEqual(picked);
        expect(combat.experience.drops).toHaveLength(1);
    });

    test("challenge bonus is capped by entry XP requirement and never rebased on bonus XP", () => {
        const map = pick(runFixture());
        const id = map.map[0]!.find(id => id !== "mixed-assault")!;
        const run = selectRunArena(map, id);
        const combat = restoreRunCombat(run);
        dropExperience(combat.experience, { x: 10, z: 10 }, 500);
        const next = settleRunSong(run, combat, { songIndex: 0, ordinaryXp: 500 });
        expect(next.route[0]!.bonusXp).toBe(18);
        expect(next.progression.experience.totalXp).toBe(518);
        expect(next.route[0]!.ordinaryXp).toBe(500);
        expect(() => settleRunSong(run, combat, { songIndex: 0, ordinaryXp: 518 })).toThrow("ledger");
    });

    test("fatal final step defeats instead of banking final drops or granting victory", () => {
        const run = activeFixture(1);
        const combat = restoreRunCombat(run);
        dropExperience(combat.experience, { x: 0, z: 0 }, 1000);
        combat.defeated = true;
        combat.health = 0;
        const dead = settleRunSong(run, combat, { songIndex: 0 });
        expect(dead.status).toBe("defeated");
        expect(dead.progression.experience.totalXp).toBe(0);
        expect(dead.route).toEqual([]);
        expect(defeatRun(dead)).toBe(dead);
        expect(() => settleRunSong(dead, combat, { songIndex: 0 })).toThrow();
        expect(() => abandonRun(dead)).toThrow();
    });

    test("rules, ranks, chart identities, route indices and queues validate before restore", () => {
        const valid = runFixture();
        const invalid: ((r: RunRecord) => void)[] = [
            r => { r.rulesVersion = 2 as 1; },
            r => { r.progression.upgrades.ranks.homing = 2; },
            r => { r.progression.upgrades.ranks.damage = -1; },
            r => { r.songs[0]!.audioHash = "b".repeat(64); },
            r => { r.songIndex = 100; },
            r => { r.progression.upgrades.pending = 2; },
            r => { r.progression.upgrades.offerIds = ["damage", "damage", "health"]; },
            r => { r.map[0] = ["elite-hunt", "pulse-grid", "mixed-assault"]; },
            r => { r.progression.experience.totalXp = 100; },
            r => { r.progression.modifiers["song:bad"] = { add: { maxHealth: 20 } }; },
        ];
        for (const corrupt of invalid) {
            const copy = structuredClone(valid);
            corrupt(copy);
            expect(() => validateRunRecord(copy)).toThrow();
        }
        expect(validateRunRecord(valid)).toEqual(valid);
    });

    test("XP conversion agrees at exact boundaries and is bounded for large grants", () => {
        const tuning = runFixture().progression.experience.tuning;
        expect(experienceAtTotal(35, tuning)).toMatchObject({ level: 1, xp: 35, requiredXp: 36 });
        expect(experienceAtTotal(36, tuning)).toMatchObject({ level: 2, xp: 0, requiredXp: 54 });
        expect(experienceAtTotal(90, tuning)).toMatchObject({ level: 3, xp: 0, requiredXp: 72 });
        expect(experienceAtTotal(1000000000, tuning).level).toBeGreaterThan(1000);
        expect(experienceAtTotal(108, { ...tuning, requirementGrowth: 0 })).toMatchObject({ level: 4, xp: 0 });
    });
});
