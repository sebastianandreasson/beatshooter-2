import { describe, expect, test } from "bun:test";
import { createCombat } from "../combat";
import { setPlayerStatModifier } from "../player-stats";
import {
    chooseUpgrade, prepareUpgradeChoices, queueUpgradeLevels,
    UPGRADE_IDS, type UpgradeId,
} from "./index";

function offer(combat: ReturnType<typeof createCombat>, id: UpgradeId): void {
    // Reach the card through actual deterministic rolls instead of injecting a choice.
    for (let count = 0; count < 100; count++) {
        queueUpgradeLevels(combat.upgrades, combat.upgrades.earnedThrough + 1);
        const choices = prepareUpgradeChoices(combat);
        if (choices.some(choice => choice.id === id)) return;
        expect(chooseUpgrade(combat, choices[0]!.id)).toBe(true);
    }
    throw new Error(`Could not find ${id}`);
}

describe("upgrade choices", () => {
    test("three distinct stable choices use an independent deterministic stream", () => {
        const first = createCombat(71);
        const second = createCombat(71);
        queueUpgradeLevels(first.upgrades, 2);
        queueUpgradeLevels(second.upgrades, 2);
        const combatRandom = first.randomState;
        const choices = prepareUpgradeChoices(first);
        const offerRandom = first.upgrades.randomState;
        expect(choices).toHaveLength(3);
        expect(new Set(choices.map(choice => choice.id)).size).toBe(3);
        expect(choices).toEqual(prepareUpgradeChoices(second));
        expect(prepareUpgradeChoices(first)).toBe(choices);
        expect(first.randomState).toBe(combatRandom);
        expect(first.upgrades.randomState).toBe(offerRandom);
        expect(first.upgrades.offeredLevel).toBe(2);
        for (const choice of choices) {
            expect(choice.rank).toBe(0);
            expect(choice.nextRank).toBe(1);
            expect(choice.detail).toContain("→");
        }
    });

    test("multi-level pickups earn one selection per level and reject stale or unoffered cards", () => {
        const combat = createCombat(20);
        queueUpgradeLevels(combat.upgrades, 4);
        queueUpgradeLevels(combat.upgrades, 4);
        queueUpgradeLevels(combat.upgrades, 2);
        expect(combat.upgrades.pending).toBe(3);
        expect(chooseUpgrade(combat, "damage")).toBe(false);
        for (const level of [2, 3, 4]) {
            const choices = prepareUpgradeChoices(combat);
            expect(combat.upgrades.offeredLevel).toBe(level);
            const absent = UPGRADE_IDS.find(id => !choices.some(choice => choice.id === id))!;
            expect(chooseUpgrade(combat, absent)).toBe(false);
            expect(chooseUpgrade(combat, choices[0]!.id)).toBe(true);
            expect(chooseUpgrade(combat, choices[0]!.id)).toBe(false);
            expect(combat.upgrades.pending).toBe(4 - level);
        }
        expect(prepareUpgradeChoices(combat)).toEqual([]);
        expect(() => queueUpgradeLevels(combat.upgrades, 1.5)).toThrow();
    });

    test("capped options disappear while at least three repeatable options remain", () => {
        const combat = createCombat(31, {}, {
            projectileCount: 7, barrageCount: 24, criticalChance: 1, bounces: 5,
        });
        for (let level = 2; level < 30; level++) {
            queueUpgradeLevels(combat.upgrades, level);
            const choices = prepareUpgradeChoices(combat);
            expect(choices).toHaveLength(3);
            for (const choice of choices) {
                expect(["damage", "health", "regeneration", "crit-damage"]).toContain(choice.id);
            }
            chooseUpgrade(combat, choices[0]!.id);
        }
    });

    test("all cards apply owned modifier ranks and preserve unrelated sources", () => {
        for (const id of UPGRADE_IDS) {
            const combat = createCombat(2026);
            setPlayerStatModifier(combat.playerStats, "external", { add: { damageMin: 1, damageMax: 1 } });
            offer(combat, id);
            const before = { ...combat.playerStats.effective };
            const oldRank = combat.upgrades.ranks[id];
            const oldHealth = combat.health = Math.min(40, before.maxHealth);
            expect(chooseUpgrade(combat, id, 12.25)).toBe(true);
            const after = combat.playerStats.effective;
            expect(combat.upgrades.ranks[id]).toBe(oldRank + 1);
            expect(combat.playerStats.modifiers.external).toEqual({ add: { damageMin: 1, damageMax: 1 } });
            expect(Object.hasOwn(combat.playerStats.modifiers, `upgrade:${id}`)).toBe(true);
            switch (id) {
                case "damage":
                    expect(after.damageMin).toBe(before.damageMin + 3);
                    expect(after.damageMax).toBe(before.damageMax + 3);
                    break;
                case "health":
                    expect(after.maxHealth).toBe(before.maxHealth + 20);
                    expect(combat.health).toBe(oldHealth + 20);
                    break;
                case "regeneration":
                    expect(after.healthRegen).toBe(before.healthRegen + 2);
                    expect(combat.regenerationDueAt).toBe(17.25);
                    break;
                case "projectiles": expect(after.projectileCount).toBe(before.projectileCount + 1); break;
                case "barrage": expect(after.barrageCount).toBe(before.barrageCount + 6); break;
                case "crit-chance": expect(after.criticalChance).toBeCloseTo(before.criticalChance + 0.05); break;
                case "crit-damage": expect(after.criticalMultiplier).toBe(before.criticalMultiplier + 0.25); break;
                case "bounce": expect(after.bounces).toBe(before.bounces + 1); break;
            }
        }
    });

    test("barrage unlocks six and repeated upgrades add two without stacking prior ranks twice", () => {
        const combat = createCombat(9);
        offer(combat, "barrage");
        chooseUpgrade(combat, "barrage");
        expect(combat.playerStats.effective.barrageCount).toBe(6);
        offer(combat, "barrage");
        chooseUpgrade(combat, "barrage");
        expect(combat.playerStats.effective.barrageCount).toBe(8);
        expect(combat.playerStats.modifiers["upgrade:barrage"]).toEqual({ add: { barrageCount: 8 } });
    });

    test("regeneration rank increases retain their musical deadline; a fresh run resets everything", () => {
        const combat = createCombat(22);
        offer(combat, "regeneration");
        chooseUpgrade(combat, "regeneration", 3);
        offer(combat, "regeneration");
        chooseUpgrade(combat, "regeneration", 4);
        expect(combat.regenerationDueAt).toBe(8);
        expect(combat.playerStats.effective.healthRegen).toBe(4);
        const fresh = createCombat(22);
        expect(fresh.upgrades.pending).toBe(0);
        expect(fresh.upgrades.choices).toEqual([]);
        expect(Object.values(fresh.upgrades.ranks).every(rank => rank === 0)).toBe(true);
        expect(fresh.regenerationDueAt).toBe(Infinity);
        expect(fresh.playerStats.effective.healthRegen).toBe(0);
    });

    test("defeat prevents preparing or selecting an upgrade", () => {
        const combat = createCombat(8);
        queueUpgradeLevels(combat.upgrades, 2);
        const choices = prepareUpgradeChoices(combat);
        combat.defeated = true;
        expect(chooseUpgrade(combat, choices[0]!.id)).toBe(false);
        expect(prepareUpgradeChoices(combat)).toEqual([]);
        expect(combat.upgrades.pending).toBe(1);
    });
});
