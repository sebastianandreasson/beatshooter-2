import { describe, expect, test } from "bun:test";
import { createCombat } from "../combat";
import { removePlayerStatModifier, setPlayerStatModifier } from "../player-stats";
import {
    chooseUpgrade, describeOwnedUpgrades, prepareUpgradeChoices, queueUpgradeLevels,
    UPGRADE_IDS, isSpecialUpgrade, SPECIAL_UPGRADE_IDS, type UpgradeId,
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
    test("the acquired build reports current effects and ranks without changing offers or combat", () => {
        const combat = createCombat(2026);
        expect(describeOwnedUpgrades(combat)).toEqual([]);
        for (const id of UPGRADE_IDS) {
            if (combat.upgrades.ranks[id] > 0) continue;
            offer(combat, id);
            expect(chooseUpgrade(combat, id)).toBe(true);
        }
        queueUpgradeLevels(combat.upgrades, combat.upgrades.earnedThrough + 1);
        prepareUpgradeChoices(combat);
        const before = structuredClone(combat);
        const owned = describeOwnedUpgrades(combat);
        const plain = (parts: (typeof owned)[number]["detailParts"]) =>
            parts.map(part => typeof part === "string" ? part : part.value).join("");
        expect(owned.map(upgrade => upgrade.id)).toEqual([...UPGRADE_IDS]);
        for (const upgrade of owned) {
            expect(upgrade.rank).toBe(combat.upgrades.ranks[upgrade.id]);
            expect(plain(upgrade.detailParts)).not.toContain("→");
            expect(plain(upgrade.descriptionParts)).not.toContain("→");
        }
        const health = owned.find(upgrade => upgrade.id === "health")!;
        const shots = owned.find(upgrade => upgrade.id === "projectiles")!;
        expect(plain(health.detailParts)).toBe(`${combat.playerStats.effective.maxHealth} maximum health`);
        expect(plain(health.descriptionParts)).not.toContain("health now");
        expect(plain(shots.detailParts)).toBe(`${combat.playerStats.effective.projectileCount} projectiles`);
        expect(plain(shots.descriptionParts)).toContain(`${Math.round(combat.playerStats.effective.damageMultiplier * 100)}%`);
        expect(combat).toEqual(before);
    });

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
            if (!isSpecialUpgrade(choice.id)) expect(choice.detail).toContain("→");
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
            pickupRadiusMultiplier: 3, dashDistance: 7.2,
            wallBounces: 1, homing: 1, regenerativeShield: 1,
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
                case "projectiles":
                    expect(after.projectileCount).toBe(before.projectileCount + 1);
                    expect(after.damageMultiplier).toBeCloseTo(before.damageMultiplier - 0.1);
                    break;
                case "barrage": expect(after.barrageCount).toBe(before.barrageCount + 6); break;
                case "crit-chance": expect(after.criticalChance).toBeCloseTo(before.criticalChance + 0.05); break;
                case "crit-damage": expect(after.criticalMultiplier).toBe(before.criticalMultiplier + 0.25); break;
                case "bounce": expect(after.bounces).toBe(before.bounces + 1); break;
                case "pickup-radius": expect(after.pickupRadiusMultiplier).toBeCloseTo(before.pickupRadiusMultiplier + 0.25); break;
                case "dash-distance": expect(after.dashDistance).toBeCloseTo(before.dashDistance + 0.6); break;
                case "wall-bounce": expect(after.wallBounces).toBe(1); break;
                case "homing": expect(after.homing).toBe(1); break;
                case "regenerative-shield":
                    expect(after.regenerativeShield).toBe(1);
                    expect(combat.shieldRechargeAt).toBe(12.25);
                    break;
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

    test("utility ranks replace their own modifier, stop offering at the cap, and reset with a new run", () => {
        for (const [id, ranks, field, base, increment, cap] of [
            ["pickup-radius", 8, "pickupRadiusMultiplier", 1, 0.25, 3],
            ["dash-distance", 6, "dashDistance", 3.6, 0.6, 7.2],
        ] as const) {
            const combat = createCombat(91);
            for (let rank = 1; rank <= ranks; rank++) {
                offer(combat, id);
                const choice = combat.upgrades.choices.find(choice => choice.id === id)!;
                expect(choice.nextRank).toBe(rank);
                expect(chooseUpgrade(combat, id)).toBe(true);
                expect(combat.playerStats.effective[field]).toBeCloseTo(base + increment * rank);
                expect(combat.playerStats.modifiers[`upgrade:${id}`]?.add?.[field]).toBeCloseTo(increment * rank);
            }
            expect(combat.playerStats.effective[field]).toBeCloseTo(cap);
            for (let roll = 0; roll < 20; roll++) {
                queueUpgradeLevels(combat.upgrades, combat.upgrades.earnedThrough + 1);
                const choices = prepareUpgradeChoices(combat);
                expect(choices.some(choice => choice.id === id)).toBe(false);
                expect(chooseUpgrade(combat, choices[0]!.id)).toBe(true);
            }
            const reset = createCombat(91);
            expect(reset.playerStats.effective[field]).toBe(base);
            expect(reset.upgrades.ranks[id]).toBe(0);
        }
    });

    test("card emphasis identifies numeric effects without coloring prose or unchanged timing", () => {
        for (const id of UPGRADE_IDS) {
            const combat = createCombat(2026);
            offer(combat, id);
            const choice = combat.upgrades.choices.find(choice => choice.id === id)!;
            const expectedCategory = id === "health" || id === "regeneration" || id === "regenerative-shield" ? "health"
                : id === "pickup-radius" || id === "dash-distance" ? "utility" : "damage";
            const values = choice.detailParts.filter(part => typeof part !== "string");
            expect(values).toHaveLength(id === "wall-bounce" || id === "homing" ? 1 : 2);
            for (const part of values) {
                expect(part.category).toBe(expectedCategory);
                expect(part.value).toMatch(/^\d+(?:[.–]\d+)*(?:[%×])?$/);
            }
            const plain = (parts: typeof choice.detailParts) => parts.map(part => typeof part === "string" ? part : part.value).join("");
            expect(plain(choice.detailParts)).toBe(choice.detail);
            expect(plain(choice.descriptionParts)).toBe(choice.description);
            if (id === "health") {
                expect(choice.descriptionParts).toContainEqual({ value: "20", category: "health" });
            } else if (id === "bounce") {
                expect(choice.descriptionParts).toContainEqual({ value: "70%", category: "damage" });
            } else if (id === "projectiles") {
                expect(choice.descriptionParts).toContainEqual({ value: "100%", category: "damage" });
                expect(choice.descriptionParts).toContainEqual({ value: "90%", category: "damage" });
            } else {
                expect(choice.descriptionParts.every(part => typeof part === "string")).toBe(true);
            }
        }
    });

    test("specials are rare, distinct, stable, and permanently single-tier within a run", () => {
        const counts = Object.fromEntries(SPECIAL_UPGRADE_IDS.map(id => [id, 0])) as Record<string, number>;
        let ordinary = 0;
        for (let seed = 0; seed < 5000; seed++) {
            const combat = createCombat(seed);
            combat.upgrades.pending = 1;
            const choices = prepareUpgradeChoices(combat);
            const special = choices.filter(choice => choice.rarity === "special");
            expect(special.length).toBeLessThanOrEqual(1);
            expect(new Set(choices.map(choice => choice.id)).size).toBe(3);
            const random = combat.upgrades.randomState;
            expect(prepareUpgradeChoices(combat)).toBe(choices);
            expect(combat.upgrades.randomState).toBe(random);
            if (!special.length) ordinary++;
            for (const choice of special) counts[choice.id]!++;
        }
        // Deterministic frequency check: around 12% of offers, ~4% per special.
        expect(ordinary / 5000).toBeGreaterThan(0.85);
        expect(ordinary / 5000).toBeLessThan(0.91);
        for (const id of SPECIAL_UPGRADE_IDS) {
            expect(counts[id]! / 5000).toBeGreaterThan(0.025);
            expect(counts[id]! / 5000).toBeLessThan(0.055);
            const combat = createCombat(2026);
            offer(combat, id);
            expect(chooseUpgrade(combat, id, 3)).toBe(true);
            expect(combat.upgrades.ranks[id]).toBe(1);
            for (let i = 0; i < 150; i++) {
                queueUpgradeLevels(combat.upgrades, combat.upgrades.earnedThrough + 1);
                const choices = prepareUpgradeChoices(combat);
                expect(choices.some(choice => choice.id === id)).toBe(false);
                expect(chooseUpgrade(combat, id)).toBe(false);
                chooseUpgrade(combat, choices[0]!.id);
            }
            expect(combat.upgrades.ranks[id]).toBe(1);
            expect(createCombat().upgrades.ranks[id]).toBe(0);
        }
    });

    test("Split Shot ranks keep 90 through 40 percent damage and the penalty can be removed", () => {
        const combat = createCombat(2026);
        setPlayerStatModifier(combat.playerStats, "external-multiplier", { multiply: { damageMultiplier: 2 } });
        for (let rank = 1; rank <= 6; rank++) {
            offer(combat, "projectiles");
            const card = combat.upgrades.choices.find(choice => choice.id === "projectiles")!;
            expect(card.description).toContain(`${200 - (rank - 1) * 20}% → ${200 - rank * 20}%`);
            chooseUpgrade(combat, "projectiles");
            expect(combat.playerStats.effective.projectileCount).toBe(rank + 1);
            expect(combat.playerStats.effective.damageMultiplier).toBeCloseTo((100 - rank * 10) / 100 * 2);
        }
        expect(combat.upgrades.ranks.projectiles).toBe(6);
        removePlayerStatModifier(combat.playerStats, "upgrade:projectiles");
        expect(combat.playerStats.effective.damageMultiplier).toBe(2);
        expect(combat.playerStats.effective.projectileCount).toBe(1);
        expect(createCombat().playerStats.effective.damageMultiplier).toBe(1);
    });

    test("Power previews the actual damage range after Split Shot's global penalty", () => {
        const combat = createCombat(2026);
        offer(combat, "projectiles");
        chooseUpgrade(combat, "projectiles");
        offer(combat, "damage");
        const stats = combat.playerStats.effective;
        const card = combat.upgrades.choices.find(choice => choice.id === "damage")!;
        expect(card.detail).toBe(
            `${Math.round(stats.damageMin * 0.9)}–${Math.round(stats.damageMax * 0.9)} → ${Math.round((stats.damageMin + 3) * 0.9)}–${Math.round((stats.damageMax + 3) * 0.9)} damage`,
        );
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
