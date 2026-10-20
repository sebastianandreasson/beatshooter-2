/** Player stats are separate from arena/enemy tuning and reset with each run. */
export interface PlayerStatsValues {
    damageMin: number;
    damageMax: number;
    /** Applies to every player projectile after its base damage and critical roll. */
    damageMultiplier: number;
    criticalChance: number;
    criticalMultiplier: number;
    maxHealth: number;
    /** Health restored on the first authored beat after five music seconds. */
    healthRegen: number;
    projectileCount: number;
    barrageCount: number;
    bounces: number;
    /** Single-tier special upgrades, clamped to zero or one. */
    wallBounces: number;
    homing: number;
    regenerativeShield: number;
    afterImage: number;
    forkingShots: number;
    /** Fraction of the killing projectile's fired damage; zero disables death blasts. */
    explosionDamageMultiplier: number;
    /** Scales blast area, so the radius scales with its square root. */
    explosionAreaMultiplier: number;
    /** Scales the range that starts attracting XP; collection contact is unchanged. */
    pickupRadiusMultiplier: number;
    /** World-space distance captured when a dash is accepted. */
    dashDistance: number;
}

export const MAX_PICKUP_RADIUS_MULTIPLIER = 3;
export const MAX_DASH_DISTANCE = 7.2;

export const DEFAULT_PLAYER_STATS: Readonly<PlayerStatsValues> = Object.freeze({
    damageMin: 13,
    damageMax: 17,
    damageMultiplier: 1,
    criticalChance: 0.12,
    criticalMultiplier: 2,
    maxHealth: 100,
    healthRegen: 0,
    projectileCount: 1,
    barrageCount: 0,
    bounces: 0,
    wallBounces: 0,
    homing: 0,
    regenerativeShield: 0,
    afterImage: 0,
    forkingShots: 0,
    explosionDamageMultiplier: 0,
    explosionAreaMultiplier: 1,
    pickupRadiusMultiplier: 1,
    dashDistance: 3.6,
});

export interface PlayerStatModifier {
    readonly add?: Readonly<Partial<PlayerStatsValues>>;
    readonly multiply?: Readonly<Partial<PlayerStatsValues>>;
}

export interface PlayerDamageMetrics {
    readonly shotsFired: number;
    readonly hits: number;
    readonly criticalHits: number;
    /** Actual enemy health removed, excluding overkill and damage to the player. */
    readonly totalDamageDealt: number;
    readonly lastHitDamage: number;
}

export interface PlayerStatsState {
    readonly base: Readonly<PlayerStatsValues>;
    readonly effective: Readonly<PlayerStatsValues>;
    readonly modifiers: Readonly<Record<string, PlayerStatModifier>>;
    readonly metrics: PlayerDamageMetrics;
}

type MutableState = { -readonly [Key in keyof PlayerStatsState]: PlayerStatsState[Key] };
const keys = [
    "damageMin", "damageMax", "damageMultiplier", "criticalChance", "criticalMultiplier",
    "maxHealth", "healthRegen", "projectileCount", "barrageCount", "bounces",
    "wallBounces", "homing", "regenerativeShield",
    "afterImage", "forkingShots", "explosionDamageMultiplier", "explosionAreaMultiplier",
    "pickupRadiusMultiplier", "dashDistance",
] as const;

export function createPlayerStats(overrides: Partial<PlayerStatsValues> = {}): PlayerStatsState {
    validateFields(overrides, false);
    const base = Object.freeze({ ...DEFAULT_PLAYER_STATS, ...overrides });
    if (base.criticalChance > 1) throw new RangeError("Base critical chance must be between 0 and 1.");
    if (base.maxHealth < 1 || base.projectileCount < 1) {
        throw new RangeError("Maximum health and projectile count must be at least one.");
    }
    const effective = resolveStats(base, {});
    return {
        base,
        effective,
        modifiers: Object.freeze({}),
        metrics: Object.freeze({
            shotsFired: 0,
            hits: 0,
            criticalHits: 0,
            totalDamageDealt: 0,
            lastHitDamage: 0,
        }),
    };
}

/**
 * An ID identifies one upgrade/status source. Setting it again replaces that
 * source instead of stacking it twice. Validation happens before either
 * snapshot changes, so an invalid replacement leaves the old source intact.
 */
export function setPlayerStatModifier(
    state: PlayerStatsState,
    id: string,
    modifier: PlayerStatModifier,
): void {
    validateId(id);
    for (const field of Object.keys(modifier)) {
        if (field !== "add" && field !== "multiply") {
            throw new RangeError(`Unknown player stat modifier field: ${field}.`);
        }
    }
    if (modifier.add) validateFields(modifier.add, true);
    if (modifier.multiply) validateFields(modifier.multiply, false);
    const copy = Object.freeze({
        ...(modifier.add ? { add: Object.freeze({ ...modifier.add }) } : {}),
        ...(modifier.multiply ? { multiply: Object.freeze({ ...modifier.multiply }) } : {}),
    });
    commitModifiers(state, { ...state.modifiers, [id]: copy });
}

export function removePlayerStatModifier(state: PlayerStatsState, id: string): boolean {
    validateId(id);
    if (!Object.hasOwn(state.modifiers, id)) return false;
    const next = { ...state.modifiers };
    delete next[id];
    commitModifiers(state, next);
    return true;
}

/**
 * The caller supplies both seeded samples. Rolling does not mutate stats or
 * consume a global RNG; each projectile keeps this result even if stats change.
 */
export function rollPlayerDamage(
    state: PlayerStatsState,
    damageRoll: number,
    criticalRoll: number,
): { damage: number; critical: boolean } {
    for (const roll of [damageRoll, criticalRoll]) {
        if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
            throw new RangeError("Damage samples must be finite numbers in [0, 1).");
        }
    }
    const stats = state.effective;
    const baseDamage = Math.min(
        stats.damageMax,
        stats.damageMin + Math.floor(damageRoll * (stats.damageMax - stats.damageMin + 1)),
    );
    const critical = criticalRoll < stats.criticalChance;
    return {
        damage: Math.round(baseDamage * stats.damageMultiplier * (critical ? stats.criticalMultiplier : 1)),
        critical,
    };
}

/** Call only after a projectile is successfully added to the combat state. */
export function recordPlayerShot(state: PlayerStatsState): void {
    const shotsFired = state.metrics.shotsFired + 1;
    if (!Number.isSafeInteger(shotsFired)) throw new RangeError("Shot count exceeded the safe range.");
    (state as MutableState).metrics = Object.freeze({ ...state.metrics, shotsFired });
}

/** Call once for a resolved enemy impact, with health removed rather than rolled damage. */
export function recordPlayerHit(
    state: PlayerStatsState,
    actualDamage: number,
    critical: boolean,
): void {
    if (!Number.isFinite(actualDamage) || actualDamage < 0 || actualDamage > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Dealt damage must be a finite nonnegative safe number.");
    }
    if (actualDamage === 0) return;
    const metrics = state.metrics;
    const hits = metrics.hits + 1;
    const criticalHits = metrics.criticalHits + (critical ? 1 : 0);
    const totalDamageDealt = metrics.totalDamageDealt + actualDamage;
    if (!Number.isSafeInteger(hits) || !Number.isSafeInteger(criticalHits)
        || !Number.isFinite(totalDamageDealt) || totalDamageDealt > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Damage metrics exceeded the safe range.");
    }
    (state as MutableState).metrics = Object.freeze({
        ...metrics, hits, criticalHits, totalDamageDealt, lastHitDamage: actualDamage,
    });
}

function validateId(id: string): void {
    if (typeof id !== "string" || !id.trim()) {
        throw new RangeError("A player stat modifier needs a nonempty source ID.");
    }
}

function validateFields(values: Readonly<Partial<PlayerStatsValues>>, signed: boolean): void {
    for (const [key, value] of Object.entries(values)) {
        if (!keys.includes(key as keyof PlayerStatsValues)) {
            throw new RangeError(`Unknown player stat: ${key}.`);
        }
        if (!Number.isFinite(value) || (!signed && value < 0)) {
            throw new RangeError(`${key} must be finite${signed ? "" : " and nonnegative"}.`);
        }
    }
}

function commitModifiers(state: PlayerStatsState, modifiers: Record<string, PlayerStatModifier>): void {
    // A fixed, locale-independent order also fixes floating-point operation order.
    const sorted = Object.freeze(Object.fromEntries(
        Object.keys(modifiers).sort().map((id) => [id, modifiers[id]!]),
    ));
    const effective = resolveStats(state.base, sorted);
    const mutable = state as MutableState;
    mutable.modifiers = sorted;
    mutable.effective = effective;
}

function resolveStats(
    base: Readonly<PlayerStatsValues>,
    modifiers: Readonly<Record<string, PlayerStatModifier>>,
): Readonly<PlayerStatsValues> {
    const result = { ...base };
    for (const key of keys) {
        let additions = 0;
        let multiplier = 1;
        for (const id of Object.keys(modifiers).sort()) {
            const modifier = modifiers[id]!;
            additions += modifier.add?.[key] ?? 0;
            multiplier *= modifier.multiply?.[key] ?? 1;
        }
        const value = (base[key] + additions) * multiplier;
        if (!Number.isFinite(additions) || !Number.isFinite(multiplier) || !Number.isFinite(value)) {
            throw new RangeError(`${key} exceeded the finite stat range.`);
        }
        if (key === "criticalChance") result[key] = Math.min(1, Math.max(0, value));
        else {
            if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
                throw new RangeError(`${key} must resolve to a nonnegative safe number.`);
            }
            result[key] = key === "damageMultiplier" || key === "criticalMultiplier" || key === "pickupRadiusMultiplier" || key === "dashDistance"
                || key === "explosionDamageMultiplier" || key === "explosionAreaMultiplier"
                ? value : Math.round(value);
        }
    }
    result.maxHealth = Math.max(1, result.maxHealth);
    result.projectileCount = Math.min(7, Math.max(1, result.projectileCount));
    result.barrageCount = Math.min(24, result.barrageCount);
    result.bounces = Math.min(5, result.bounces);
    result.wallBounces = Math.min(1, result.wallBounces);
    result.homing = Math.min(1, result.homing);
    result.regenerativeShield = Math.min(1, result.regenerativeShield);
    result.afterImage = Math.min(1, result.afterImage);
    result.forkingShots = Math.min(1, result.forkingShots);
    result.pickupRadiusMultiplier = Math.min(MAX_PICKUP_RADIUS_MULTIPLIER, result.pickupRadiusMultiplier);
    result.dashDistance = Math.min(MAX_DASH_DISTANCE, result.dashDistance);
    if (base.damageMin > base.damageMax || result.damageMin > result.damageMax) {
        throw new RangeError("Minimum damage must not exceed maximum damage.");
    }
    if (!Number.isSafeInteger(Math.round(result.damageMax * result.damageMultiplier))
        || !Number.isSafeInteger(Math.round(result.damageMax * result.damageMultiplier * result.criticalMultiplier))) {
        throw new RangeError("Critical damage exceeded the safe integer range.");
    }
    return Object.freeze(result);
}
