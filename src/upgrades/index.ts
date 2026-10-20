import type { CombatState } from "../combat";
import {
    MAX_DASH_DISTANCE, MAX_PICKUP_RADIUS_MULTIPLIER,
    setPlayerStatModifier,
    type PlayerStatModifier,
    type PlayerStatsValues,
} from "../player-stats";

export const UPGRADE_IDS = [
    "damage", "health", "regeneration", "projectiles", "barrage",
    "crit-chance", "crit-damage", "bounce", "pickup-radius", "dash-distance",
] as const;
export type UpgradeId = typeof UPGRADE_IDS[number];
export type UpgradeCategory = "damage" | "health" | "utility";
export type UpgradeTextPart = string | Readonly<{ value: string; category: UpgradeCategory }>;

export interface UpgradeChoice {
    id: UpgradeId;
    title: string;
    description: string;
    rank: number;
    nextRank: number;
    detail: string;
    detailParts: readonly UpgradeTextPart[];
    descriptionParts: readonly UpgradeTextPart[];
}

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
        default: return true;
    }
}

function description(id: UpgradeId, rank: number, stats: Readonly<PlayerStatsValues>): UpgradeChoice {
    const value = (amount: number | string, category: UpgradeCategory): UpgradeTextPart =>
        Object.freeze({ value: typeof amount === "number" ? String(Number(amount.toFixed(2))) : amount, category });
    const damage = (amount: number | string) => value(amount, "damage");
    const health = (amount: number | string) => value(amount, "health");
    const utility = (amount: number | string) => value(amount, "utility");
    const plain = (parts: readonly UpgradeTextPart[]) => parts.map(part => typeof part === "string" ? part : part.value).join("");
    const card = (title: string, descriptionParts: UpgradeTextPart[], detailParts: UpgradeTextPart[]): UpgradeChoice => ({
        id, rank, nextRank: rank + 1, title,
        description: plain(descriptionParts), detail: plain(detailParts),
        descriptionParts: Object.freeze(descriptionParts), detailParts: Object.freeze(detailParts),
    });
    switch (id) {
        case "damage": return card("Power",
            ["Every new projectile deals more damage."],
            [damage(`${stats.damageMin}–${stats.damageMax}`), " → ", damage(`${stats.damageMin + 3}–${stats.damageMax + 3}`), " damage"]);
        case "health": return card("Vitality",
            ["Increase maximum health and restore ", health(20), " health now."],
            [health(stats.maxHealth), " → ", health(stats.maxHealth + 20), " maximum health"]);
        case "regeneration": return card("Regeneration",
            ["Restore health every 5 music seconds, landing on the next beat."],
            [health(stats.healthRegen), " → ", health(stats.healthRegen + 2), " health / 5 seconds"]);
        case "projectiles": return card("Split Shot",
            ["Add a projectile to a centered fan on every firing beat."],
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
            ["After a hit, wait for the next beat and bounce to a new enemy."],
            [damage(stats.bounces), " → ", damage(stats.bounces + 1), " bounces / projectile"]);
        case "pickup-radius": return card("Pickup Radius",
            ["Pull XP gems in from farther away."],
            [utility(`${Math.round(stats.pickupRadiusMultiplier * 100)}%`), " → ",
                utility(`${Math.round(Math.min(MAX_PICKUP_RADIUS_MULTIPLIER, stats.pickupRadiusMultiplier + 0.25) * 100)}%`), " pickup radius"]);
        case "dash-distance": return card("Dash Distance",
            ["Travel farther with each on-beat dash."],
            [utility(stats.dashDistance), " → ", utility(Math.min(MAX_DASH_DISTANCE, stats.dashDistance + 0.6)), " dash distance"]);
    }
}

/** Repeated render calls keep the same three choices and never reroll the RNG. */
export function prepareUpgradeChoices(combat: CombatState): readonly UpgradeChoice[] {
    const upgrades = combat.upgrades;
    if (upgrades.pending <= 0 || combat.defeated) return [];
    if (upgrades.choices.length > 0) return upgrades.choices;
    const pool = UPGRADE_IDS.filter(id => available(id, combat.playerStats.effective));
    const choices: UpgradeChoice[] = [];
    for (let slot = 0; slot < 3 && pool.length > 0; slot++) {
        const index = Math.floor(offerRandom(upgrades) * pool.length);
        const [id] = pool.splice(index, 1);
        if (id) choices.push(description(id, upgrades.ranks[id], combat.playerStats.effective));
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
        case "projectiles": return { add: { projectileCount: rank } };
        case "barrage": return { add: { barrageCount: rank > 0 ? 6 + (rank - 1) * 2 : 0 } };
        case "crit-chance": return { add: { criticalChance: rank * 0.05 } };
        case "crit-damage": return { add: { criticalMultiplier: rank * 0.25 } };
        case "bounce": return { add: { bounces: rank } };
        case "pickup-radius": return { add: { pickupRadiusMultiplier: rank * 0.25 } };
        case "dash-distance": return { add: { dashDistance: rank * 0.6 } };
    }
}

/** Only offered cards can mutate stats; the session also validates the offer level. */
export function chooseUpgrade(
    combat: CombatState,
    id: UpgradeId,
    songPosition = combat.time,
): boolean {
    const upgrades = combat.upgrades;
    if (combat.defeated || upgrades.pending <= 0 || !Number.isFinite(songPosition)
        || !upgrades.choices.some(choice => choice.id === id)
        || !available(id, combat.playerStats.effective)) return false;
    const rank = upgrades.ranks[id] + 1;
    const oldRegen = combat.playerStats.effective.healthRegen;
    setPlayerStatModifier(combat.playerStats, `upgrade:${id}`, modifierFor(id, rank));
    if (id === "health") {
        combat.health = Math.min(combat.playerStats.effective.maxHealth, combat.health + 20);
    }
    if (oldRegen === 0 && combat.playerStats.effective.healthRegen > 0) {
        combat.regenerationDueAt = songPosition + 5;
    }
    upgrades.ranks[id] = rank;
    upgrades.pending--;
    upgrades.choices = [];
    upgrades.offeredLevel = 0;
    return true;
}
