import type { CombatState } from "../combat";
import {
    MAX_DASH_DISTANCE, MAX_PICKUP_RADIUS_MULTIPLIER,
    setPlayerStatModifier,
    type PlayerStatModifier,
    type PlayerStatsValues,
} from "../player-stats";

export const STANDARD_UPGRADE_IDS = [
    "damage", "health", "regeneration", "projectiles", "barrage",
    "crit-chance", "crit-damage", "bounce", "pickup-radius", "dash-distance", "exploding-enemies",
] as const;
export const SPECIAL_UPGRADE_IDS = ["wall-bounce", "homing", "regenerative-shield", "after-image", "forking-shots"] as const;
export const SPECIAL_OFFER_CHANCE = 0.12;
export const UPGRADE_IDS = [...STANDARD_UPGRADE_IDS, ...SPECIAL_UPGRADE_IDS] as const;
export type UpgradeId = typeof UPGRADE_IDS[number];
export type UpgradeCategory = "damage" | "health" | "utility";
export type UpgradeTextPart = string | Readonly<{ value: string; category: UpgradeCategory }>;

export interface UpgradeChoice {
    id: UpgradeId;
    title: string;
    description: string;
    rank: number;
    nextRank: number;
    rarity: "standard" | "special";
    detail: string;
    detailParts: readonly UpgradeTextPart[];
    descriptionParts: readonly UpgradeTextPart[];
}

export type OwnedUpgrade = Pick<UpgradeChoice,
    "id" | "title" | "rank" | "rarity" | "detailParts" | "descriptionParts">;

export interface UpgradeState {
    ranks: Record<UpgradeId, number>;
    pending: number;
    choices: readonly UpgradeChoice[];
    /** Highest earned level; prevents repeated fixed steps from queuing it twice. */
    earnedThrough: number;
    offeredLevel: number;
    /** Offers never consume combat's spawn or damage random sequence. */
    randomState: number;
}

export function createUpgradeState(seed = 1): UpgradeState {
    return {
        ranks: Object.fromEntries(UPGRADE_IDS.map(id => [id, 0])) as Record<UpgradeId, number>,
        pending: 0, choices: [], earnedThrough: 1, offeredLevel: 0,
        randomState: (seed ^ 0xA17E4D3B) >>> 0,
    };
}

/** A large XP pickup earns every intervening choice, in level order. */
export function queueUpgradeLevels(state: UpgradeState, level: number): void {
    if (!Number.isSafeInteger(level) || level < 1) throw new RangeError("Invalid upgrade level.");
    if (level <= state.earnedThrough) return;
    state.pending += level - state.earnedThrough;
    state.earnedThrough = level;
}

function offerRandom(state: UpgradeState): number {
    state.randomState = (state.randomState + 0x6D2B79F5) >>> 0;
    let value = state.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function available(id: UpgradeId, stats: Readonly<PlayerStatsValues>): boolean {
    switch (id) {
        case "projectiles": return stats.projectileCount < 7;
        case "barrage": return stats.barrageCount < 24;
        case "crit-chance": return stats.criticalChance < 1;
        case "bounce": return stats.bounces < 5;
        case "pickup-radius": return stats.pickupRadiusMultiplier < MAX_PICKUP_RADIUS_MULTIPLIER;
        case "dash-distance": return stats.dashDistance < MAX_DASH_DISTANCE - 1e-9;
        case "wall-bounce": return stats.wallBounces < 1;
        case "homing": return stats.homing < 1;
        case "regenerative-shield": return stats.regenerativeShield < 1;
        case "after-image": return stats.afterImage < 1;
        case "forking-shots": return stats.forkingShots < 1;
        default: return true;
    }
}

const splitShotDamageMultiplier = (rank: number): number => Math.max(0, 100 - rank * 10) / 100;

function description(id: UpgradeId, rank: number, stats: Readonly<PlayerStatsValues>): UpgradeChoice {
    const value = (amount: number | string, category: UpgradeCategory): UpgradeTextPart =>
        Object.freeze({ value: typeof amount === "number" ? String(Number(amount.toFixed(2))) : amount, category });
    const damage = (amount: number | string) => value(amount, "damage");
    const health = (amount: number | string) => value(amount, "health");
    const utility = (amount: number | string) => value(amount, "utility");
    const damageRange = (bonus = 0) => `${Math.round((stats.damageMin + bonus) * stats.damageMultiplier)}–${Math.round((stats.damageMax + bonus) * stats.damageMultiplier)}`;
    const plain = (parts: readonly UpgradeTextPart[]) => parts.map(part => typeof part === "string" ? part : part.value).join("");
    const card = (title: string, descriptionParts: UpgradeTextPart[], detailParts: UpgradeTextPart[]): UpgradeChoice => ({
        id, rank, nextRank: rank + 1, title,
        rarity: isSpecialUpgrade(id) ? "special" : "standard",
        description: plain(descriptionParts), detail: plain(detailParts),
        descriptionParts: Object.freeze(descriptionParts), detailParts: Object.freeze(detailParts),
    });
    switch (id) {
        case "damage": return card("Power",
            ["Every new projectile deals more damage."],
            [damage(damageRange()), " → ", damage(damageRange(3)), " damage"]);
        case "health": return card("Vitality",
            ["Increase maximum health and restore ", health(20), " health now."],
            [health(stats.maxHealth), " → ", health(stats.maxHealth + 20), " maximum health"]);
        case "regeneration": return card("Regeneration",
            ["Restore health every 5 music seconds, landing on the next beat."],
            [health(stats.healthRegen), " → ", health(stats.healthRegen + 2), " health / 5 seconds"]);
        case "projectiles": return card("Split Shot",
            ["Add a projectile on every firing beat. All weapon damage: ",
                damage(`${Math.round(stats.damageMultiplier * 100)}%`), " → ",
                damage(`${Math.round(stats.damageMultiplier * splitShotDamageMultiplier(rank + 1)
                    / Math.max(0.01, splitShotDamageMultiplier(rank)) * 100)}%`),
                ". −", damage("10%"), " per rank."],
            [damage(stats.projectileCount), " → ", damage(stats.projectileCount + 1), " projectiles"]);
        case "barrage": return card("Downbeat Barrage",
            ["Fire a ring of projectiles on each accented main beat."],
            [damage(stats.barrageCount), " → ", damage(Math.min(24, stats.barrageCount + (rank === 0 ? 6 : 2))), " projectiles / main beat"]);
        case "crit-chance": return card("Critical Chance",
            ["More projectiles roll a critical hit."],
            [damage(`${Math.round(stats.criticalChance * 100)}%`), " → ", damage(`${Math.min(100, Math.round(stats.criticalChance * 100) + 5)}%`), " critical chance"]);
        case "crit-damage": return card("Critical Damage",
            ["Critical projectiles hit harder."],
            [damage(`${stats.criticalMultiplier}×`), " → ", damage(`${stats.criticalMultiplier + 0.25}×`), " critical damage"]);
        case "bounce": return card("Ricochet",
            ["Bounce to a new enemy on the next beat. Retain ", damage("70%"), " damage per bounce."],
            [damage(stats.bounces), " → ", damage(stats.bounces + 1), " bounces / projectile"]);
        case "pickup-radius": return card("Pickup Radius",
            ["Pull XP gems in from farther away."],
            [utility(`${Math.round(stats.pickupRadiusMultiplier * 100)}%`), " → ",
                utility(`${Math.round(Math.min(MAX_PICKUP_RADIUS_MULTIPLIER, stats.pickupRadiusMultiplier + 0.25) * 100)}%`), " pickup radius"]);
        case "dash-distance": return card("Dash Distance",
            ["Travel farther with each on-beat dash."],
            [utility(stats.dashDistance), " → ", utility(Math.min(MAX_DASH_DISTANCE, stats.dashDistance + 0.6)), " dash distance"]);
        case "wall-bounce": return card("Wall Bounce",
            ["Shots rebound once from a wall with full damage. The next wall stops them."],
            [damage(1), " wall rebound / projectile"]);
        case "homing": return card("Homing Shots",
            ["Shots bend gently toward the closest enemy ahead. A small correction, with no sharp turns."],
            ["Up to ", damage(30), "° total steering / projectile"]);
        case "regenerative-shield": return card("Regenerative Shield",
            ["Block one hit, then recharge over 25 seconds of song time. Starts charged."],
            [health(1), " hit blocked · ", health(25), "s recharge"]);
        case "exploding-enemies": return card("Exploding Enemies",
            ["Defeated enemies explode and can chain through nearby enemies. Blast area: ",
                damage(`${Math.round(stats.explosionAreaMultiplier * 100)}%`), " → ",
                damage(`${Math.round((stats.explosionAreaMultiplier + (rank > 0 ? 0.05 : 0)) * 100)}%`),
                ". Base radius: ", damage(2.5), " units."],
            [damage(`${Math.round(stats.explosionDamageMultiplier * 100)}%`), " → ",
                damage(`${Math.round((stats.explosionDamageMultiplier + (rank > 0 ? 0.1 : 0.5)) * 100)}%`), " projectile damage"]);
        case "after-image": return card("After Image",
            ["Dashing leaves a stationary clone that mirrors your shots and aim until the next bar."],
            [utility(1), " clone · lasts until the next bar"]);
        case "forking-shots": return card("Forking Shots",
            ["The first enemy hit splits a shot into two smaller, short-range shots. Ricochets and forked shots cannot fork again."],
            [damage(2), " shots · ", damage("20%"), " damage each · ", damage(8), " range"]);
    }
}

export function isSpecialUpgrade(id: UpgradeId): boolean {
    return (SPECIAL_UPGRADE_IDS as readonly string[]).includes(id);
}

/** Read the acquired build without preparing an offer or advancing any RNG. */
export function describeOwnedUpgrades(combat: CombatState): OwnedUpgrade[] {
    return UPGRADE_IDS.filter(id => combat.upgrades.ranks[id] > 0).map(id => {
        const rank = combat.upgrades.ranks[id];
        const choice = description(id, rank, combat.playerStats.effective);
        // Offer details contain current value, arrow, next value, then units.
        // Retain the current value and units; unique upgrades have no arrow.
        const arrow = choice.detailParts.indexOf(" → ");
        const detailParts = arrow < 0 ? choice.detailParts
            : [...choice.detailParts.slice(0, arrow), ...choice.detailParts.slice(arrow + 2)];
        const descriptionParts: readonly UpgradeTextPart[] = id === "health"
            ? ["Increases your maximum health. Each rank restored 20 health when selected."]
            : id === "projectiles" ? ["Fire additional projectiles on every firing beat. All weapon damage: ",
                { value: `${Math.round(combat.playerStats.effective.damageMultiplier * 100)}%`, category: "damage" },
                ". Each rank reduces weapon damage by 10 percentage points."]
            : id === "exploding-enemies" ? ["Defeated enemies explode and can chain through nearby enemies. Blast area: ",
                { value: `${Math.round(combat.playerStats.effective.explosionAreaMultiplier * 100)}%`, category: "damage" },
                ". Base radius: ", { value: "2.5", category: "damage" }, " units."]
            : choice.descriptionParts;
        return { id, rank, title: choice.title, rarity: choice.rarity, detailParts, descriptionParts };
    });
}

/** Repeated render calls keep the same three choices and never reroll the RNG. */
export function prepareUpgradeChoices(combat: CombatState): readonly UpgradeChoice[] {
    const upgrades = combat.upgrades;
    if (upgrades.pending <= 0 || combat.defeated) return [];
    if (upgrades.choices.length > 0) return upgrades.choices;
    const pool = STANDARD_UPGRADE_IDS.filter(id => available(id, combat.playerStats.effective));
    const choices: UpgradeChoice[] = [];
    for (let slot = 0; slot < 3 && pool.length > 0; slot++) {
        const index = Math.floor(offerRandom(upgrades) * pool.length);
        const [id] = pool.splice(index, 1);
        if (id) choices.push(description(id, upgrades.ranks[id], combat.playerStats.effective));
    }
    const specials = SPECIAL_UPGRADE_IDS.filter(id => upgrades.ranks[id] === 0
        && available(id, combat.playerStats.effective));
    // One rare slot at most. Normal offers and the combat RNG remain independent.
    if (specials.length && offerRandom(upgrades) < SPECIAL_OFFER_CHANCE) {
        const id = specials[Math.floor(offerRandom(upgrades) * specials.length)]!;
        const slot = Math.floor(offerRandom(upgrades) * Math.max(1, choices.length));
        choices[slot] = description(id, 0, combat.playerStats.effective);
    }
    upgrades.offeredLevel = upgrades.earnedThrough - upgrades.pending + 1;
    upgrades.choices = Object.freeze(choices.map(choice => Object.freeze(choice)));
    return upgrades.choices;
}

function modifierFor(id: UpgradeId, rank: number): PlayerStatModifier {
    switch (id) {
        case "damage": return { add: { damageMin: rank * 3, damageMax: rank * 3 } };
        case "health": return { add: { maxHealth: rank * 20 } };
        case "regeneration": return { add: { healthRegen: rank * 2 } };
        case "projectiles": return {
            add: { projectileCount: rank },
            multiply: { damageMultiplier: splitShotDamageMultiplier(rank) },
        };
        case "barrage": return { add: { barrageCount: rank > 0 ? 6 + (rank - 1) * 2 : 0 } };
        case "crit-chance": return { add: { criticalChance: rank * 0.05 } };
        case "crit-damage": return { add: { criticalMultiplier: rank * 0.25 } };
        case "bounce": return { add: { bounces: rank } };
        case "pickup-radius": return { add: { pickupRadiusMultiplier: rank * 0.25 } };
        case "dash-distance": return { add: { dashDistance: rank * 0.6 } };
        case "wall-bounce": return { add: { wallBounces: 1 } };
        case "homing": return { add: { homing: 1 } };
        case "regenerative-shield": return { add: { regenerativeShield: 1 } };
        case "after-image": return { add: { afterImage: 1 } };
        case "forking-shots": return { add: { forkingShots: 1 } };
        case "exploding-enemies": return { add: {
            explosionDamageMultiplier: rank > 0 ? (50 + (rank - 1) * 10) / 100 : 0,
            explosionAreaMultiplier: Math.max(0, rank - 1) * 0.05,
        } };
    }
}

/** Checkpoint reconstruction uses these pure definitions without choosing/healing. */
export {
    description as describeUpgrade, modifierFor as upgradeModifierFor,
    available as isUpgradeAvailable,
};

/** Only offered cards can mutate stats; the session also validates the offer level. */
export function chooseUpgrade(
    combat: CombatState,
    id: UpgradeId,
    songPosition = combat.time,
): boolean {
    const upgrades = combat.upgrades;
    if (combat.defeated || upgrades.pending <= 0 || !Number.isFinite(songPosition)
        || !upgrades.choices.some(choice => choice.id === id)
        || (isSpecialUpgrade(id) && upgrades.ranks[id] > 0)
        || !available(id, combat.playerStats.effective)) return false;
    const rank = upgrades.ranks[id] + 1;
    const oldRegen = combat.playerStats.effective.healthRegen;
    setPlayerStatModifier(combat.playerStats, `upgrade:${id}`, modifierFor(id, rank));
    if (id === "health") {
        combat.health = Math.min(combat.playerStats.effective.maxHealth, combat.health + 20);
    }
    if (id === "regenerative-shield") combat.shieldRechargeAt = songPosition;
    if (oldRegen === 0 && combat.playerStats.effective.healthRegen > 0) {
        combat.regenerationDueAt = songPosition + 5;
    }
    upgrades.ranks[id] = rank;
    upgrades.pending--;
    upgrades.choices = [];
    upgrades.offeredLevel = 0;
    return true;
}
