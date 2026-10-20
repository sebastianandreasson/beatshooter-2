import { describe, expect, test } from "bun:test";
import { advanceExperience, createExperience, DEFAULT_EXPERIENCE_TUNING, dropExperience } from "./state";

const origin = { x: 0, z: 0 };

describe("experience drops", () => {
    test("enemy drops persist without awarding XP until the player reaches them", () => {
        const state = createExperience();
        const position = { x: 10, z: -4 };
        const drop = dropExperience(state, position);
        position.x = 99;
        for (let step = 0; step < 600; step++) advanceExperience(state, 1 / 60, origin);
        expect(state.drops).toEqual([{
            id: 1, x: 10, z: -4, previousX: 10, previousZ: -4,
            value: 10, attracted: false, speed: 0,
        }]);
        expect(drop.x).toBe(10);
        expect(state.totalXp).toBe(0);
        expect(state.xp).toBe(0);
        expect(state.level).toBe(1);
    });

    test("magnet entry starts acceleration without granting XP early", () => {
        const state = createExperience();
        const drop = dropExperience(state, { x: 3.5, z: 0 });
        expect(advanceExperience(state, 1 / 60, origin)).toEqual({
            collected: 0, gainedXp: 0, levelsGained: 0,
        });
        expect(drop.attracted).toBe(true);
        expect(drop.speed).toBeGreaterThan(state.tuning.attractionSpeed);
        expect(drop.previousX).toBe(3.5);
        expect(drop.x).toBeGreaterThan(state.tuning.pickupRadius);
        expect(drop.x).toBeLessThan(3.5);
        expect(state.totalXp).toBe(0);
    });

    test("a 25 percent pickup upgrade attracts out to 4.375 without collecting early", () => {
        const state = createExperience();
        const atBoundary = dropExperience(state, { x: 4.375, z: 0 });
        const outside = dropExperience(state, { x: -4.376, z: 0 });
        advanceExperience(state, 1 / 60, origin);
        expect(atBoundary.attracted).toBe(false);
        expect(outside.attracted).toBe(false);
        expect(advanceExperience(state, 1 / 60, origin, origin, 1.25).collected).toBe(0);
        expect(atBoundary.attracted).toBe(true);
        expect(atBoundary.x).toBeLessThan(4.375);
        expect(atBoundary.x).toBeGreaterThan(state.tuning.pickupRadius);
        expect(outside.attracted).toBe(false);
        expect(outside.x).toBe(-4.376);
        expect(state.totalXp).toBe(0);
        expect(state.tuning).toEqual(DEFAULT_EXPERIENCE_TUNING);
    });

    test("upgraded attraction catches a swept path outside base range", () => {
        const start = { x: -8, z: 0 }, end = { x: 8, z: 0 };
        const base = createExperience(), upgraded = createExperience();
        const baseDrop = dropExperience(base, { x: 0, z: 4 });
        const upgradedDrop = dropExperience(upgraded, { x: 0, z: 4 });
        advanceExperience(base, 1 / 60, end, start);
        expect(advanceExperience(upgraded, 1 / 60, end, start, 1.25).collected).toBe(0);
        expect(baseDrop.attracted).toBe(false);
        expect(upgradedDrop.attracted).toBe(true);
        expect(upgradedDrop.x).toBeGreaterThan(0);
        expect(upgradedDrop.z).toBeLessThan(4);
        expect(Math.hypot(upgradedDrop.x, upgradedDrop.z - 4)).toBeLessThan(14 / 60);
        // Once a gem starts moving, losing the upgrade does not strand it.
        const previousX = upgradedDrop.x;
        advanceExperience(upgraded, 1 / 60, end, end, 1);
        expect(upgradedDrop.x).toBeGreaterThan(previousX);
    });

    test("pickup upgrades scale custom magnet tuning while leaving collection contact unchanged", () => {
        const state = createExperience({
            magnetRadius: 2, pickupRadius: 0.4, attractionSpeed: 0.01, attractionAcceleration: 0,
        });
        const tuning = { ...state.tuning };
        const atBoundary = dropExperience(state, { x: 2.5, z: 0 });
        const outside = dropExperience(state, { x: -2.501, z: 0 });
        const nearContact = dropExperience(state, { x: 0, z: 0.45 });
        expect(advanceExperience(state, 1 / 60, origin, origin, 1.25).collected).toBe(0);
        expect(atBoundary.attracted).toBe(true);
        expect(outside.attracted).toBe(false);
        expect(nearContact.attracted).toBe(true);
        expect(nearContact.z).toBeGreaterThan(tuning.pickupRadius);
        for (let step = 0; step < 10; step++) advanceExperience(state, 1 / 60, origin, origin, 1.25);
        expect(outside.attracted).toBe(false);
        expect(state.tuning).toEqual(tuning);
        expect(state.totalXp).toBe(0);
    });

    test("zero attraction multiplier still collects direct and swept physical contact", () => {
        const state = createExperience();
        dropExperience(state, { x: state.tuning.pickupRadius, z: 0 });
        const outside = dropExperience(state, { x: 0, z: state.tuning.pickupRadius + 0.01 });
        expect(advanceExperience(state, 1 / 60, origin, origin, 0).collected).toBe(1);
        expect(outside.attracted).toBe(false);
        dropExperience(state, origin);
        expect(advanceExperience(state, 1 / 60, { x: 8, z: 0 }, { x: -8, z: 0 }, 0).collected).toBe(1);
        expect(outside.attracted).toBe(false);
        expect(state.totalXp).toBe(20);
    });

    test("invalid pickup multipliers reject before changing gems or progression", () => {
        const state = createExperience();
        dropExperience(state, { x: 0.5, z: 0 });
        dropExperience(state, { x: 2, z: 0 });
        const snapshot = structuredClone(state);
        for (const multiplier of [-0.01, 3.001, NaN, Infinity, -Infinity]) {
            expect(() => advanceExperience(state, 1 / 60, origin, origin, multiplier)).toThrow(RangeError);
            expect(state).toEqual(snapshot);
        }
    });

    test("a nearby fast pass latches attraction even when both endpoints are out of range", () => {
        const state = createExperience();
        const drop = dropExperience(state, { x: 0, z: 3 });
        const result = advanceExperience(state, 1 / 60, { x: 8, z: 0 }, { x: -8, z: 0 });
        expect(result.collected).toBe(0);
        expect(drop.attracted).toBe(true);
        expect(drop.x).toBeGreaterThan(0);
        expect(drop.z).toBeLessThan(3);
        expect(Math.hypot(drop.x - 8, drop.z)).toBeGreaterThan(state.tuning.magnetRadius);
        const previousX = drop.x;
        advanceExperience(state, 1 / 60, { x: 8, z: 0 });
        expect(drop.x).toBeGreaterThan(previousX);
        expect(drop.attracted).toBe(true);
        for (let i = 0; i < 120 && state.drops.length; i++) {
            advanceExperience(state, 1 / 60, { x: 8, z: 0 });
        }
        expect(state.drops).toHaveLength(0);
        expect(state.totalXp).toBe(10);
    });

    test("a dash through a gem collects exactly once with endpoints outside the magnet", () => {
        const state = createExperience();
        dropExperience(state, origin, 17);
        expect(advanceExperience(state, 1 / 60, { x: 8, z: 0 }, { x: -8, z: 0 })).toEqual({
            collected: 1, gainedXp: 17, levelsGained: 0,
        });
        expect(state.drops).toHaveLength(0);
        expect(state.totalXp).toBe(17);
        expect(advanceExperience(state, 1 / 60, origin)).toEqual({
            collected: 0, gainedXp: 0, levelsGained: 0,
        });
        expect(state.totalXp).toBe(17);
    });

    test("a pass beyond the magnet does not activate a gem", () => {
        const state = createExperience();
        const drop = dropExperience(state, { x: 0, z: 3.51 });
        advanceExperience(state, 1 / 60, { x: 8, z: 0 }, { x: -8, z: 0 });
        expect(drop.attracted).toBe(false);
        expect(drop.speed).toBe(0);
        expect(drop.x).toBe(0);
        expect(drop.z).toBe(3.51);
    });

    test("large movement steps cannot overshoot a pickup or award it twice", () => {
        const state = createExperience();
        dropExperience(state, { x: -3, z: 0 });
        dropExperience(state, { x: 0, z: 3 });
        expect(advanceExperience(state, 5, origin)).toEqual({
            collected: 2, gainedXp: 20, levelsGained: 0,
        });
        expect(state.drops).toHaveLength(0);
        expect(state.xp).toBe(20);
        expect(advanceExperience(state, 5, origin).gainedXp).toBe(0);
    });

    test("the entity cap merges into the nearest gem while conserving every point", () => {
        const state = createExperience({ dropCap: 2 });
        const left = dropExperience(state, { x: -8, z: 0 });
        const right = dropExperience(state, { x: 8, z: 0 }, 15);
        expect(dropExperience(state, { x: 7, z: 1 }, 25)).toBe(right);
        expect(dropExperience(state, { x: 0, z: 0 }, 13)).toBe(left);
        for (let i = 0; i < 1_000; i++) dropExperience(state, { x: 8, z: 0 }, 1);
        expect(state.drops).toHaveLength(2);
        expect(state.nextId).toBe(3);
        expect(left.value).toBe(23);
        expect(right.value).toBe(1040);
        expect(state.drops.reduce((sum, drop) => sum + drop.value, 0)).toBe(1063);
        expect(state.totalXp).toBe(0);
        expect(advanceExperience(state, 1 / 60, right).gainedXp).toBe(1040);
        expect(advanceExperience(state, 1 / 60, left).gainedXp).toBe(23);
        expect(state.drops).toHaveLength(0);
        expect(state.totalXp).toBe(1063);
    });

    test("invalid time or player data leaves all state untouched", () => {
        const state = createExperience();
        dropExperience(state, { x: 2, z: 0 });
        const snapshot = structuredClone(state);
        for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
            expect(advanceExperience(state, dt, origin)).toEqual({
                collected: 0, gainedXp: 0, levelsGained: 0,
            });
            expect(state).toEqual(snapshot);
        }
        advanceExperience(state, 1 / 60, { x: NaN, z: 0 });
        advanceExperience(state, 1 / 60, origin, { x: Infinity, z: 0 });
        expect(state).toEqual(snapshot);
    });

    test("new runs are independent and identical fixed-step commands replay deterministically", () => {
        const replay = () => {
            const state = createExperience({ dropCap: 8 });
            for (let i = 0; i < 30; i++) dropExperience(state, { x: i % 5 - 2, z: Math.floor(i / 5) - 3 });
            for (let i = 0; i < 120; i++) {
                const position = { x: Math.sin(i / 12) * 5, z: Math.cos(i / 12) * 5 };
                const previous = { x: Math.sin((i - 1) / 12) * 5, z: Math.cos((i - 1) / 12) * 5 };
                advanceExperience(state, 1 / 60, position, previous);
            }
            return state;
        };
        expect(replay()).toEqual(replay());
        expect(replay().totalXp).toBe(300);
        const fresh = createExperience();
        expect(fresh.level).toBe(1);
        expect(fresh.xp).toBe(0);
        expect(fresh.totalXp).toBe(0);
        expect(fresh.requiredXp).toBe(DEFAULT_EXPERIENCE_TUNING.initialRequirement);
        expect(fresh.nextId).toBe(1);
        expect(fresh.drops).toEqual([]);
        const other = createExperience();
        fresh.tuning.dropValue = 99;
        dropExperience(fresh, origin);
        expect(other.tuning.dropValue).toBe(10);
        expect(other.drops).toEqual([]);
    });
});

describe("experience levels", () => {
    test("level thresholds carry XP and grow without changing other game stats", () => {
        const state = createExperience();
        dropExperience(state, origin, 35);
        expect(advanceExperience(state, 1 / 60, origin).levelsGained).toBe(0);
        expect([state.level, state.xp, state.requiredXp, state.totalXp]).toEqual([1, 35, 36, 35]);
        dropExperience(state, origin, 1);
        expect(advanceExperience(state, 1 / 60, origin).levelsGained).toBe(1);
        expect([state.level, state.xp, state.requiredXp, state.totalXp]).toEqual([2, 0, 54, 36]);
        dropExperience(state, origin, 59);
        expect(advanceExperience(state, 1 / 60, origin).levelsGained).toBe(1);
        expect([state.level, state.xp, state.requiredXp, state.totalXp]).toEqual([3, 5, 72, 95]);
    });

    test("one merged pickup can cross multiple levels, including an exact final threshold", () => {
        const state = createExperience({ dropCap: 1 });
        dropExperience(state, origin, 36);
        dropExperience(state, origin, 54);
        dropExperience(state, origin, 72);
        expect(advanceExperience(state, 1 / 60, origin)).toEqual({
            collected: 1, gainedXp: 162, levelsGained: 3,
        });
        expect([state.level, state.xp, state.requiredXp, state.totalXp]).toEqual([4, 0, 90, 162]);
        dropExperience(state, origin, 199);
        expect(advanceExperience(state, 1 / 60, origin).levelsGained).toBe(2);
        expect([state.level, state.xp, state.requiredXp, state.totalXp]).toEqual([6, 1, 126, 361]);
    });

    test("large pickups use the same arithmetic progression as sequential level thresholds", () => {
        for (const value of [35, 36, 37, 89, 90, 91, 161, 162, 163, 1_000, 100_000_000]) {
            const state = createExperience();
            dropExperience(state, origin, value);
            const result = advanceExperience(state, 1 / 60, origin);
            let expectedLevel = 1;
            let remaining = value;
            let requirement = DEFAULT_EXPERIENCE_TUNING.initialRequirement;
            while (remaining >= requirement) {
                remaining -= requirement;
                requirement += DEFAULT_EXPERIENCE_TUNING.requirementGrowth;
                expectedLevel++;
            }
            expect(result.levelsGained).toBe(expectedLevel - 1);
            expect(state.level).toBe(expectedLevel);
            expect(state.xp).toBe(remaining);
            expect(state.requiredXp).toBe(requirement);
            expect(state.totalXp).toBe(value);
        }
    });

    test("constant requirements and large growth remain valid tuning options", () => {
        const constant = createExperience({ initialRequirement: 1, requirementGrowth: 0 });
        dropExperience(constant, origin, 1_000_000_000);
        expect(advanceExperience(constant, 1 / 60, origin).levelsGained).toBe(1_000_000_000);
        expect([constant.level, constant.xp, constant.requiredXp]).toEqual([1_000_000_001, 0, 1]);
        const steep = createExperience({ initialRequirement: 1, requirementGrowth: 1_000_000 });
        dropExperience(steep, origin, 1);
        expect(advanceExperience(steep, 1 / 60, origin).levelsGained).toBe(1);
        expect([steep.level, steep.xp, steep.requiredXp]).toEqual([2, 0, 1_000_001]);
    });

    test("maximum safe integer XP retains the exact remainder", () => {
        const state = createExperience();
        const value = Number.MAX_SAFE_INTEGER;
        dropExperience(state, origin, value);
        const result = advanceExperience(state, 1 / 60, origin);
        const levels = BigInt(result.levelsGained);
        const exactCost = levels * BigInt(DEFAULT_EXPERIENCE_TUNING.initialRequirement)
            + BigInt(DEFAULT_EXPERIENCE_TUNING.requirementGrowth) * levels * (levels - 1n) / 2n;
        expect(BigInt(state.xp)).toBe(BigInt(value) - exactCost);
        expect(state.xp).toBeGreaterThanOrEqual(0);
        expect(state.xp).toBeLessThan(state.requiredXp);
        expect(state.totalXp).toBe(value);
        expect(Number.isSafeInteger(state.level)).toBe(true);
        expect(Number.isSafeInteger(state.requiredXp)).toBe(true);
    });

    test("combined pending and collected XP rejects overflow before changing state", () => {
        const state = createExperience({ initialRequirement: 1, requirementGrowth: 0 });
        dropExperience(state, origin, Number.MAX_SAFE_INTEGER);
        const beforeDrop = structuredClone(state);
        expect(() => dropExperience(state, origin, 1)).toThrow(RangeError);
        expect(state).toEqual(beforeDrop);
        advanceExperience(state, 1 / 60, origin);
        expect(state.totalXp).toBe(Number.MAX_SAFE_INTEGER);
        expect(state.xp).toBe(0);
        const beforeAdditional = structuredClone(state);
        expect(() => dropExperience(state, origin)).toThrow(RangeError);
        expect(state).toEqual(beforeAdditional);
        // Also guard a malformed externally restored state before moving gems.
        state.drops = [beforeDrop.drops[0]!, { ...beforeDrop.drops[0]!, id: 2 }];
        state.totalXp = 0;
        const beforeAdvance = structuredClone(state);
        expect(() => advanceExperience(state, 1 / 60, origin)).toThrow(RangeError);
        expect(state).toEqual(beforeAdvance);
    });

    test("invalid tuning and drops fail before corrupting progression", () => {
        for (const overrides of [
            { dropValue: 0 }, { dropValue: 1.5 }, { initialRequirement: -1 },
            { requirementGrowth: -1 }, { requirementGrowth: NaN },
            { dropCap: 0 }, { dropCap: 1.5 }, { magnetRadius: Infinity },
            { magnetRadius: 0.5 }, { pickupRadius: 0 },
            { attractionSpeed: -1 }, { attractionAcceleration: -1 },
        ]) expect(() => createExperience(overrides)).toThrow(RangeError);
        const state = createExperience();
        const snapshot = structuredClone(state);
        expect(() => dropExperience(state, { x: NaN, z: 0 })).toThrow(RangeError);
        for (const value of [0, -1, 0.5, NaN, Infinity]) {
            expect(() => dropExperience(state, origin, value)).toThrow(RangeError);
        }
        expect(state).toEqual(snapshot);
    });
});
