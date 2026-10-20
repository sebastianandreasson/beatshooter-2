import { createCombat, type CombatState, type CombatTuning } from "../combat";
import { createExperience, DEFAULT_EXPERIENCE_TUNING, type ExperienceTuning } from "../experience/state";
import {
    createPlayerStats, setPlayerStatModifier, DEFAULT_PLAYER_STATS,
    type PlayerDamageMetrics, type PlayerStatModifier, type PlayerStatsValues,
} from "../player-stats";
import {
    createUpgradeState, describeUpgrade, isUpgradeAvailable, prepareUpgradeChoices, upgradeModifierFor, UPGRADE_IDS,
    SPECIAL_UPGRADE_IDS, type UpgradeId,
} from "../upgrades";

/** Canonical character state. Song entities, health and absolute deadlines are deliberately absent. */
export interface RunProgression {
    base: PlayerStatsValues;
    modifiers: Record<string, PlayerStatModifier>;
    metrics: PlayerDamageMetrics;
    experience: {
        level: number;
        xp: number;
        totalXp: number;
        requiredXp: number;
        tuning: ExperienceTuning;
    };
    upgrades: {
        ranks: Record<UpgradeId, number>;
        pending: number;
        earnedThrough: number;
        offeredLevel: number;
        offerIds: UpgradeId[];
        randomState: number;
    };
    score: number;
    kills: number;
    shieldBlocks: number;
}

const permanent = (id: string) => !id.startsWith("upgrade:") &&
    !id.startsWith("song:") && !id.startsWith("encounter:");

export function snapshotProgression(combat: CombatState): RunProgression {
    const xp = combat.experience;
    // A final pickup can queue levels before the session prepares its next offer.
    // Freeze that offer in the snapshot without advancing the live character's RNG.
    const upgrades = { ...combat.upgrades, ranks: { ...combat.upgrades.ranks } };
    if (upgrades.pending && !upgrades.choices.length) {
        prepareUpgradeChoices({ ...combat, upgrades, defeated: false });
    }
    return structuredClone({
        base: { ...combat.playerStats.base },
        modifiers: Object.fromEntries(Object.entries(combat.playerStats.modifiers).filter(([id]) => permanent(id))),
        metrics: { ...combat.playerStats.metrics },
        experience: { level: xp.level, xp: xp.xp, totalXp: xp.totalXp, requiredXp: xp.requiredXp, tuning: { ...xp.tuning } },
        upgrades: {
            ranks: { ...upgrades.ranks }, pending: upgrades.pending,
            earnedThrough: upgrades.earnedThrough, offeredLevel: upgrades.offeredLevel,
            offerIds: upgrades.choices.map(choice => choice.id), randomState: upgrades.randomState,
        },
        score: combat.score, kills: combat.kills, shieldBlocks: combat.shieldBlocks,
    });
}

export function natural(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
        throw new Error(`Invalid run ${name}.`);
    }
}

/** Integer arithmetic keeps large settlement grants exact without a loop per level. */
export function experienceAtTotal(totalXp: number, tuning: ExperienceTuning): RunProgression["experience"] {
    natural(totalXp, "experience");
    const initial = BigInt(tuning.initialRequirement);
    const growth = BigInt(tuning.requirementGrowth);
    const total = BigInt(totalXp);
    const cost = (levels: bigint) => levels * initial + growth * levels * (levels - 1n) / 2n;
    let low = 0n;
    let high = total / initial + 1n;
    while (low + 1n < high) {
        const middle = (low + high) / 2n;
        if (cost(middle) <= total) low = middle;
        else high = middle;
    }
    const level = Number(low + 1n);
    const requiredXp = Number(initial + growth * low);
    natural(level, "level");
    natural(requiredXp, "next level requirement");
    return { level, xp: Number(total - cost(low)), totalXp, requiredXp, tuning: { ...tuning } };
}

export function validateProgression(value: unknown): RunProgression {
    if (!value || typeof value !== "object") throw new Error("Invalid run progression.");
    const p = structuredClone(value) as RunProgression;
    // Additive catalog update: preserve older checkpoints and their held offers.
    // Only these newly introduced fields may be absent; older required data
    // still receives the full validation below.
    if (p.base && typeof p.base === "object") {
        for (const key of ["afterImage", "forkingShots", "explosionDamageMultiplier", "explosionAreaMultiplier"] as const) {
            if (!Object.hasOwn(p.base, key)) p.base[key] = DEFAULT_PLAYER_STATS[key];
        }
    }
    if (p.upgrades?.ranks && typeof p.upgrades.ranks === "object") {
        for (const id of ["exploding-enemies", "after-image", "forking-shots"] as const) {
            if (!Object.hasOwn(p.upgrades.ranks, id)) p.upgrades.ranks[id] = 0;
        }
    }
    if (!p.base || Object.keys(DEFAULT_PLAYER_STATS).some(key => !Object.hasOwn(p.base, key))) {
        throw new Error("Run base stats are incomplete.");
    }
    const stats = createPlayerStats(p.base);
    if (!p.modifiers || typeof p.modifiers !== "object" || Array.isArray(p.modifiers) ||
        Object.keys(p.modifiers).length > 128) throw new Error("Invalid permanent modifiers.");
    for (const [id, modifier] of Object.entries(p.modifiers)) {
        if (!permanent(id)) throw new Error("Song and upgrade modifiers cannot be saved as permanent modifiers.");
        setPlayerStatModifier(stats, id, modifier);
    }
    if (!p.metrics || !p.experience || !p.upgrades || !p.upgrades.ranks) throw new Error("Incomplete run progression.");
    for (const name of ["score", "kills", "shieldBlocks"] as const) natural(p[name], name);
    for (const name of ["shotsFired", "hits", "criticalHits"] as const) natural(p.metrics[name], name);
    for (const name of ["totalDamageDealt", "lastHitDamage"] as const) {
        if (!Number.isFinite(p.metrics[name]) || p.metrics[name] < 0) throw new Error(`Invalid ${name}.`);
    }
    if (p.metrics.criticalHits > p.metrics.hits || p.metrics.lastHitDamage > p.metrics.totalDamageDealt) {
        throw new Error("Run damage metrics are inconsistent.");
    }
    const xp = p.experience;
    if (!xp.tuning || Object.keys(DEFAULT_EXPERIENCE_TUNING).some(key => !Object.hasOwn(xp.tuning, key))) {
        throw new Error("Run experience rules are incomplete.");
    }
    const tuning = createExperience(xp.tuning).tuning;
    const expected = experienceAtTotal(xp.totalXp, tuning);
    if (xp.level !== expected.level || xp.xp !== expected.xp || xp.requiredXp !== expected.requiredXp) {
        throw new Error("Run level and experience do not agree.");
    }
    p.experience = expected;
    const upgrades = p.upgrades;
    if (Object.keys(upgrades.ranks).length !== UPGRADE_IDS.length) throw new Error("Invalid upgrade ranks.");
    const caps: Partial<Record<UpgradeId, number>> = {
        projectiles: 6, barrage: 10, "crit-chance": 20, bounce: 5, "pickup-radius": 12, "dash-distance": 12,
        "wall-bounce": 1, homing: 1, "regenerative-shield": 1,
        "after-image": 1, "forking-shots": 1,
    };
    let chosen = 0;
    for (const id of UPGRADE_IDS) {
        const rank = upgrades.ranks[id];
        natural(rank, `${id} rank`, caps[id] ?? 1_000_000);
        chosen += rank;
        if (rank) setPlayerStatModifier(stats, `upgrade:${id}`, upgradeModifierFor(id, rank));
    }
    natural(upgrades.pending, "pending upgrades");
    natural(upgrades.randomState, "upgrade seed", 0xFFFFFFFF);
    if (upgrades.earnedThrough !== xp.level || chosen + upgrades.pending !== xp.level) {
        throw new Error("The run's upgrade queue does not match its earned levels.");
    }
    if (!Array.isArray(upgrades.offerIds) || upgrades.offerIds.length > 3 ||
        new Set(upgrades.offerIds).size !== upgrades.offerIds.length ||
        upgrades.offerIds.some(id => !UPGRADE_IDS.includes(id) || !isUpgradeAvailable(id, stats.effective) ||
            (SPECIAL_UPGRADE_IDS.includes(id as typeof SPECIAL_UPGRADE_IDS[number]) && upgrades.ranks[id] > 0)) ||
        (upgrades.pending === 0 && (upgrades.offerIds.length !== 0 || upgrades.offeredLevel !== 0)) ||
        (upgrades.pending > 0 && (upgrades.offerIds.length !== 3 ||
            upgrades.offeredLevel !== upgrades.earnedThrough - upgrades.pending + 1))) {
        throw new Error("The run's saved upgrade offer is invalid.");
    }
    return p;
}

/** Rebuild modifiers directly: replaying chooseUpgrade would heal and consume pending choices. */
export function restoreProgression(
    progression: RunProgression, seed = 1, tuning: Partial<CombatTuning> = {},
): CombatState {
    const p = validateProgression(progression);
    const combat = createCombat(seed, tuning, p.base);
    for (const [id, modifier] of Object.entries(p.modifiers)) setPlayerStatModifier(combat.playerStats, id, modifier);
    for (const id of UPGRADE_IDS) {
        if (p.upgrades.ranks[id]) {
            setPlayerStatModifier(combat.playerStats, `upgrade:${id}`, upgradeModifierFor(id, p.upgrades.ranks[id]));
        }
    }
    combat.playerStats = { ...combat.playerStats, metrics: Object.freeze({ ...p.metrics }) };
    combat.experience = { ...createExperience(p.experience.tuning), ...p.experience };
    combat.upgrades = {
        ...createUpgradeState(), ranks: { ...p.upgrades.ranks }, pending: p.upgrades.pending,
        earnedThrough: p.upgrades.earnedThrough, offeredLevel: p.upgrades.offeredLevel,
        randomState: p.upgrades.randomState,
        choices: Object.freeze(p.upgrades.offerIds.map(id =>
            Object.freeze(describeUpgrade(id, p.upgrades.ranks[id], combat.playerStats.effective)))),
    };
    combat.health = combat.playerStats.effective.maxHealth;
    combat.regenerationDueAt = combat.playerStats.effective.healthRegen > 0 ? 5 : Infinity;
    combat.score = p.score;
    combat.kills = p.kills;
    combat.shieldBlocks = p.shieldBlocks;
    return combat;
}
