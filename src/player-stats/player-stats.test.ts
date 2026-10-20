import { describe, expect, test } from "bun:test";
import {
    createPlayerStats,
    DEFAULT_PLAYER_STATS,
    recordPlayerHit,
    recordPlayerShot,
    removePlayerStatModifier,
    rollPlayerDamage,
    setPlayerStatModifier,
} from "./index";

describe("player weapon stats", () => {
    test("each run starts with a small inclusive damage range and independent metrics", () => {
        const first = createPlayerStats();
        const next = createPlayerStats();
        expect(first.base).toEqual(DEFAULT_PLAYER_STATS);
        expect(first.effective).toEqual(DEFAULT_PLAYER_STATS);
        expect(first.metrics).toEqual({
            shotsFired: 0, hits: 0, criticalHits: 0, totalDamageDealt: 0, lastHitDamage: 0,
        });
        recordPlayerShot(first);
        recordPlayerHit(first, 13, false);
        expect(next.metrics.shotsFired).toBe(0);
        expect(next.metrics.totalDamageDealt).toBe(0);
    });

    test("rolls every integer in the range and applies criticals at the exact chance boundary", () => {
        const stats = createPlayerStats();
        expect(Array.from({ length: 5 }, (_, i) => rollPlayerDamage(stats, (i + 0.5) / 5, 0.12)))
            .toEqual([13, 14, 15, 16, 17].map((damage) => ({ damage, critical: false })));
        expect(rollPlayerDamage(stats, 0, 0.119999)).toEqual({ damage: 26, critical: true });
        expect(rollPlayerDamage(stats, 1 - Number.EPSILON, 0)).toEqual({ damage: 34, critical: true });
        expect(stats.metrics.shotsFired).toBe(0);
        expect(stats.metrics.hits).toBe(0);
    });

    test("source IDs replace and remove contributions without changing base or previous shots", () => {
        const stats = createPlayerStats();
        const firstShot = rollPlayerDamage(stats, 0, 0.9);
        setPlayerStatModifier(stats, "weapon:power", { add: { damageMin: 2, damageMax: 2 } });
        expect(stats.effective.damageMin).toBe(15);
        setPlayerStatModifier(stats, "weapon:power", { add: { damageMin: 4, damageMax: 4 } });
        expect(stats.effective.damageMin).toBe(17);
        expect(Object.keys(stats.modifiers)).toEqual(["weapon:power"]);
        expect(firstShot).toEqual({ damage: 13, critical: false });
        expect(rollPlayerDamage(stats, 0, 0.9).damage).toBe(17);
        expect(stats.base).toEqual(DEFAULT_PLAYER_STATS);
        expect(removePlayerStatModifier(stats, "weapon:power")).toBe(true);
        expect(removePlayerStatModifier(stats, "weapon:power")).toBe(false);
        expect(stats.effective).toEqual(DEFAULT_PLAYER_STATS);
    });

    test("additions combine before multipliers in deterministic source order", () => {
        const forward = createPlayerStats();
        const reverse = createPlayerStats();
        const entries = [
            ["weapon:add", { add: { damageMin: 2, damageMax: 2 } }],
            ["buff:more", { multiply: { damageMin: 1.5, damageMax: 1.5 } }],
            ["aura:more", { multiply: { damageMin: 1.2, damageMax: 1.2 } }],
        ] as const;
        for (const [id, modifier] of entries) setPlayerStatModifier(forward, id, modifier);
        for (const [id, modifier] of [...entries].reverse()) setPlayerStatModifier(reverse, id, modifier);
        expect(forward.effective).toEqual(reverse.effective);
        expect(forward.modifiers).toEqual(reverse.modifiers);
        expect(forward.effective.damageMin).toBe(27);
        expect(forward.effective.damageMax).toBe(34);
        expect(Object.keys(forward.modifiers)).toEqual(["aura:more", "buff:more", "weapon:add"]);
    });

    test("critical chance clamps and fractional damage rounds only after all modifiers", () => {
        const stats = createPlayerStats({ damageMin: 10, damageMax: 20 });
        setPlayerStatModifier(stats, "fraction", {
            add: { damageMin: 0.25, damageMax: 0.25, criticalChance: 4 },
            multiply: { damageMin: 1.5, damageMax: 1.5, criticalMultiplier: 0.75 },
        });
        expect(stats.effective).toEqual({
            ...DEFAULT_PLAYER_STATS,
            damageMin: 15, damageMax: 30, criticalChance: 1, criticalMultiplier: 1.5,
        });
        expect(rollPlayerDamage(stats, 0, 0.999).damage).toBe(23);
        setPlayerStatModifier(stats, "fraction", { add: { criticalChance: -4 } });
        expect(stats.effective.criticalChance).toBe(0);
        expect(rollPlayerDamage(stats, 0, 0).critical).toBe(false);
    });

    test("invalid replacements preserve every existing snapshot and metric", () => {
        const stats = createPlayerStats();
        setPlayerStatModifier(stats, "power", { add: { damageMin: 2, damageMax: 2 } });
        recordPlayerShot(stats);
        const before = { ...stats };
        for (const modifier of [
            { add: { damageMin: 100 } },
            { add: { damageMin: -100 } },
            { multiply: { damageMax: -1 } },
            { multiply: { damageMax: Number.POSITIVE_INFINITY } },
            { multiply: { damageMax: Number.MAX_VALUE } },
            { add: { criticalMultiplier: Number.MAX_SAFE_INTEGER } },
            { add: { damageMin: Number.NaN } },
        ]) {
            expect(() => setPlayerStatModifier(stats, "power", modifier)).toThrow(RangeError);
            expect(stats.base).toBe(before.base);
            expect(stats.effective).toBe(before.effective);
            expect(stats.modifiers).toBe(before.modifiers);
            expect(stats.metrics).toBe(before.metrics);
        }
    });

    test("removing a prerequisite modifier is atomic if another modifier would become invalid", () => {
        const stats = createPlayerStats();
        setPlayerStatModifier(stats, "upper", { add: { damageMax: 10 } });
        setPlayerStatModifier(stats, "lower", { add: { damageMin: 8 } });
        const effective = stats.effective;
        const modifiers = stats.modifiers;
        expect(() => removePlayerStatModifier(stats, "upper")).toThrow(RangeError);
        expect(stats.effective).toBe(effective);
        expect(stats.modifiers).toBe(modifiers);
        removePlayerStatModifier(stats, "lower");
        expect(removePlayerStatModifier(stats, "upper")).toBe(true);
        expect(stats.effective).toEqual(DEFAULT_PLAYER_STATS);
    });

    test("caller-owned input objects cannot mutate saved stats or contributions", () => {
        const base = { damageMin: 15, damageMax: 20 };
        const stats = createPlayerStats(base);
        const modifier = { add: { damageMin: 1, damageMax: 1 } };
        setPlayerStatModifier(stats, "power", modifier);
        base.damageMin = 900;
        modifier.add.damageMin = 900;
        expect(stats.base.damageMin).toBe(15);
        expect(stats.modifiers.power?.add?.damageMin).toBe(1);
        expect(stats.effective.damageMin).toBe(16);
        expect(Object.isFrozen(stats.base)).toBe(true);
        expect(Object.isFrozen(stats.effective)).toBe(true);
        expect(Object.isFrozen(stats.modifiers)).toBe(true);
        expect(Object.isFrozen(stats.modifiers.power?.add)).toBe(true);
    });

    test("rejects invalid base values and random samples before producing damage", () => {
        for (const overrides of [
            { damageMin: -1 }, { damageMin: 20 }, { criticalChance: 1.01 },
            { criticalChance: -0.1 }, { criticalMultiplier: Number.NaN },
            { damageMax: Number.MAX_SAFE_INTEGER }, { damageMax: Number.POSITIVE_INFINITY },
        ]) expect(() => createPlayerStats(overrides)).toThrow(RangeError);
        const stats = createPlayerStats();
        for (const sample of [-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => rollPlayerDamage(stats, sample, 0.5)).toThrow(RangeError);
            expect(() => rollPlayerDamage(stats, 0.5, sample)).toThrow(RangeError);
        }
        expect(() => setPlayerStatModifier(stats, "", {})).toThrow(RangeError);
        expect(() => removePlayerStatModifier(stats, "  ")).toThrow(RangeError);
        expect(rollPlayerDamage(createPlayerStats({ damageMin: 0, damageMax: 0 }), 0.5, 0.5))
            .toEqual({ damage: 0, critical: false });
    });

    test("counts only confirmed positive damage and does not mutate earlier metric snapshots", () => {
        const stats = createPlayerStats();
        const initial = stats.metrics;
        recordPlayerShot(stats);
        recordPlayerShot(stats);
        recordPlayerShot(stats);
        recordPlayerHit(stats, 15, false);
        recordPlayerHit(stats, 9, true); // 30 rolled, but only 9 health remained.
        const afterHits = stats.metrics;
        recordPlayerHit(stats, 0, true);
        expect(stats.metrics).toBe(afterHits);
        expect(stats.metrics).toEqual({
            shotsFired: 3, hits: 2, criticalHits: 1, totalDamageDealt: 24, lastHitDamage: 9,
        });
        expect(initial.totalDamageDealt).toBe(0);
        for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => recordPlayerHit(stats, invalid, false)).toThrow(RangeError);
            expect(stats.metrics).toBe(afterHits);
        }
    });

    test("supports arbitrary source IDs without prototype-property collisions", () => {
        const stats = createPlayerStats();
        expect(removePlayerStatModifier(stats, "toString")).toBe(false);
        setPlayerStatModifier(stats, "__proto__", { add: { damageMin: 1, damageMax: 1 } });
        expect(stats.effective.damageMin).toBe(14);
        expect(Object.keys(stats.modifiers)).toEqual(["__proto__"]);
        expect(removePlayerStatModifier(stats, "__proto__")).toBe(true);
        expect(stats.effective).toEqual(DEFAULT_PLAYER_STATS);
    });

    test("extended stats resolve through the same named modifiers and cap projectile budgets", () => {
        const stats = createPlayerStats();
        setPlayerStatModifier(stats, "upgrades", {
            add: { maxHealth: 20, healthRegen: 2, projectileCount: 20, barrageCount: 40, bounces: 10 },
        });
        expect(stats.effective).toEqual({
            ...DEFAULT_PLAYER_STATS,
            maxHealth: 120, healthRegen: 2, projectileCount: 7, barrageCount: 24, bounces: 5,
        });
        expect(() => createPlayerStats({ maxHealth: 0 })).toThrow(RangeError);
        expect(() => createPlayerStats({ projectileCount: 0 })).toThrow(RangeError);
        expect(() => setPlayerStatModifier(stats, "bad", { add: { healthRegen: -100 } }))
            .toThrow(RangeError);
        removePlayerStatModifier(stats, "upgrades");
        expect(stats.effective).toEqual(DEFAULT_PLAYER_STATS);
    });
});
