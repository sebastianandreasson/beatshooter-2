export interface Vec2 {
    x: number;
    z: number;
}

export interface ExperienceTuning {
    dropValue: number;
    initialRequirement: number;
    requirementGrowth: number;
    magnetRadius: number;
    pickupRadius: number;
    attractionSpeed: number;
    attractionAcceleration: number;
    dropCap: number;
}

export const DEFAULT_EXPERIENCE_TUNING: Readonly<ExperienceTuning> = Object.freeze({
    dropValue: 10,
    initialRequirement: 36,
    requirementGrowth: 18,
    magnetRadius: 3.5,
    pickupRadius: 0.65,
    attractionSpeed: 14,
    attractionAcceleration: 20,
    dropCap: 512,
});

export interface ExperienceDrop extends Vec2 {
    id: number;
    previousX: number;
    previousZ: number;
    value: number;
    attracted: boolean;
    speed: number;
}

export interface ExperienceState {
    level: number;
    /** Progress toward the next level, after carrying across earned levels. */
    xp: number;
    totalXp: number;
    requiredXp: number;
    drops: ExperienceDrop[];
    nextId: number;
    tuning: ExperienceTuning;
}

export interface ExperienceStep {
    collected: number;
    gainedXp: number;
    levelsGained: number;
}

export function createExperience(overrides: Partial<ExperienceTuning> = {}): ExperienceState {
    const tuning = { ...DEFAULT_EXPERIENCE_TUNING, ...overrides };
    for (const key of ["dropValue", "initialRequirement", "dropCap"] as const) {
        if (!Number.isSafeInteger(tuning[key]) || tuning[key] <= 0) {
            throw new RangeError(`${key} must be a positive safe integer.`);
        }
    }
    if (!Number.isSafeInteger(tuning.requirementGrowth) || tuning.requirementGrowth < 0) {
        throw new RangeError("requirementGrowth must be a nonnegative safe integer.");
    }
    for (const key of ["magnetRadius", "pickupRadius", "attractionSpeed"] as const) {
        if (!Number.isFinite(tuning[key]) || tuning[key] <= 0) {
            throw new RangeError(`${key} must be a positive finite number.`);
        }
    }
    if (!Number.isFinite(tuning.attractionAcceleration) || tuning.attractionAcceleration < 0) {
        throw new RangeError("attractionAcceleration must be a nonnegative finite number.");
    }
    if (tuning.magnetRadius < tuning.pickupRadius) {
        throw new RangeError("magnetRadius must include pickupRadius.");
    }
    return {
        level: 1,
        xp: 0,
        totalXp: 0,
        requiredXp: tuning.initialRequirement,
        drops: [],
        nextId: 1,
        tuning,
    };
}

/** Never grants XP at the enemy's death: only a later physical pickup earns it. */
export function dropExperience(
    state: ExperienceState,
    position: Vec2,
    value = state.tuning.dropValue,
): ExperienceDrop {
    if (!validPosition(position)) throw new RangeError("Experience drops need a finite position.");
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("Experience drop value must be a positive safe integer.");
    }
    assertExperienceRange(state, value);
    if (state.drops.length >= state.tuning.dropCap) {
        let nearest = state.drops[0]!;
        let nearestDistance = distanceSquared(nearest, position);
        for (const drop of state.drops) {
            const distance = distanceSquared(drop, position);
            if (distance < nearestDistance || (distance === nearestDistance && drop.id < nearest.id)) {
                nearest = drop;
                nearestDistance = distance;
            }
        }
        nearest.value += value;
        return nearest;
    }
    const drop: ExperienceDrop = {
        id: state.nextId++,
        x: position.x,
        z: position.z,
        previousX: position.x,
        previousZ: position.z,
        value,
        attracted: false,
        speed: 0,
    };
    state.drops.push(drop);
    return drop;
}

/**
 * Fixed-step gameplay owns pickup timing. Attraction stays latched after the
 * player leaves the magnet, and a swept test catches fast movement in either
 * direction. The caller freezes the system whenever the run is paused.
 */
export function advanceExperience(
    state: ExperienceState,
    dt: number,
    player: Vec2,
    previousPlayer: Vec2 = player,
): ExperienceStep {
    const result: ExperienceStep = { collected: 0, gainedXp: 0, levelsGained: 0 };
    if (!Number.isFinite(dt) || dt <= 0 || !validPosition(player) || !validPosition(previousPlayer)) {
        return result;
    }
    assertExperienceRange(state);
    const remaining: ExperienceDrop[] = [];
    for (const drop of state.drops) {
        drop.previousX = drop.x;
        drop.previousZ = drop.z;
        let attractionStart = 0;
        if (!drop.attracted) {
            const entry = circleEntry(previousPlayer, player, drop, state.tuning.magnetRadius);
            if (entry === undefined) {
                remaining.push(drop);
                continue;
            }
            attractionStart = entry;
            drop.attracted = true;
            drop.speed = state.tuning.attractionSpeed;
        }
        // A dash may only enter the magnet late in this step. Give that gem
        // just the remaining time to travel, not the entire tick.
        const movingTime = dt * (1 - attractionStart);
        const distance = Math.hypot(player.x - drop.x, player.z - drop.z);
        const nextSpeed = drop.speed + state.tuning.attractionAcceleration * movingTime;
        const travel = Math.min(distance, (drop.speed + nextSpeed) * 0.5 * movingTime);
        drop.speed = nextSpeed;
        if (distance > 0) {
            drop.x += (player.x - drop.x) / distance * travel;
            drop.z += (player.z - drop.z) / distance * travel;
        }
        const playerAtStart = {
            x: previousPlayer.x + (player.x - previousPlayer.x) * attractionStart,
            z: previousPlayer.z + (player.z - previousPlayer.z) * attractionStart,
        };
        const relativeStart = {
            x: drop.previousX - playerAtStart.x,
            z: drop.previousZ - playerAtStart.z,
        };
        const relativeEnd = { x: drop.x - player.x, z: drop.z - player.z };
        if (circleEntry(relativeStart, relativeEnd, { x: 0, z: 0 }, state.tuning.pickupRadius) !== undefined) {
            result.collected++;
            result.gainedXp += drop.value;
        } else {
            remaining.push(drop);
        }
    }
    state.drops = remaining;
    if (result.gainedXp > 0) result.levelsGained = grantExperience(state, result.gainedXp);
    return result;
}

function grantExperience(state: ExperienceState, value: number): number {
    state.totalXp += value;
    state.xp += value;
    if (state.xp < state.requiredXp) return 0;
    const requirement = state.requiredXp;
    const growth = state.tuning.requirementGrowth;
    // Thresholds form an arithmetic series. Solve its sum rather than looping
    // once per level when a gem holds a large amount of merged experience.
    const linear = 2 * requirement - growth;
    const root = Math.sqrt(linear * linear + 8 * growth * state.xp);
    let levels = growth === 0 ? Math.floor(state.xp / requirement)
        : Math.floor(linear >= 0 ? 4 * state.xp / (linear + root) : (root - linear) / (2 * growth));
    const cost = (count: number) => count * requirement + growth * count * (count - 1) / 2;
    // Correct a possible floating-point rounding at an exact threshold.
    if (growth > 0) {
        while (cost(levels) > state.xp) levels--;
        while (cost(levels + 1) <= state.xp) levels++;
    }
    state.xp -= cost(levels);
    state.level += levels;
    state.requiredXp += growth * levels;
    return levels;
}

/** Include pending gems so several valid drops cannot overflow on collection. */
function assertExperienceRange(state: ExperienceState, additional = 0): void {
    let total = state.totalXp + additional;
    if (!Number.isSafeInteger(total) || total < 0) {
        throw new RangeError("Total experience exceeds the safe integer range.");
    }
    for (const drop of state.drops) {
        total += drop.value;
        if (!Number.isSafeInteger(total)) {
            throw new RangeError("Total experience exceeds the safe integer range.");
        }
    }
}

function validPosition(position: Vec2): boolean {
    return Number.isFinite(position.x) && Number.isFinite(position.z);
}

function distanceSquared(a: Vec2, b: Vec2): number {
    return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

/** Earliest segment/circle intersection, including an initial overlap. */
function circleEntry(start: Vec2, end: Vec2, center: Vec2, radius: number): number | undefined {
    const offsetX = start.x - center.x;
    const offsetZ = start.z - center.z;
    const c = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
    if (c <= 0) return 0;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const a = dx * dx + dz * dz;
    if (a === 0) return undefined;
    const b = 2 * (offsetX * dx + offsetZ * dz);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return undefined;
    const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
    return entry >= 0 && entry <= 1 ? entry : undefined;
}
