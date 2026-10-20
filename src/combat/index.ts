import {
    createEnemy, enemyVelocity, ENEMY_COLLISION_GROUP, findSpawnPosition, waveSize,
    type Enemy,
} from "../enemies";

export type { Enemy } from "../enemies";
export interface Vec2 { x: number; z: number }
export const PLAYER_COLLISION_GROUP = 1;
export const WALL_COLLISION_GROUP = 4;
export const PROJECTILE_COLLISION_GROUP = 8;

export interface CombatTuning {
    arenaHalfExtent: number;
    spawnInset: number;
    spawnBand: number;
    spawnSafetyRadius: number;
    playerRadius: number;
    playerHealth: number;
    contactDamage: number;
    contactExtraRange: number;
    invulnerabilitySeconds: number;
    enemyRadius: number;
    enemyHealth: number;
    enemySpeed: number;
    enemyMaxSpeed: number;
    enemySpeedIncrease: number;
    speedIncreaseEveryBars: number;
    enemyCap: number;
    initialWaveSize: number;
    waveIncreaseEveryBars: number;
    maxWaveSize: number;
    projectileSpeed: number;
    projectileLifetime: number;
    projectileRadius: number;
    projectileCap: number;
    damageMin: number;
    damageMax: number;
    criticalChance: number;
    criticalMultiplier: number;
    knockbackSpeed: number;
    knockbackDuration: number;
    knockbackDecay: number;
    effectLifetime: number;
    effectCap: number;
    killScore: number;
    beatSurvivalScore: number;
    fireEveryBeats: number;
    beatsPerBar: number;
}

/** One configuration for gameplay; every session receives its own copy. */
export const DEFAULT_COMBAT_TUNING: Readonly<CombatTuning> = Object.freeze({
    arenaHalfExtent: 18,
    spawnInset: 1,
    spawnBand: 2,
    spawnSafetyRadius: 7,
    playerRadius: 0.55,
    playerHealth: 100,
    contactDamage: 15,
    contactExtraRange: 0.2,
    invulnerabilitySeconds: 0.9,
    enemyRadius: 0.55,
    enemyHealth: 24,
    enemySpeed: 2.5,
    enemyMaxSpeed: 3.6,
    enemySpeedIncrease: 0.15,
    speedIncreaseEveryBars: 8,
    enemyCap: 100,
    initialWaveSize: 1,
    waveIncreaseEveryBars: 12,
    maxWaveSize: 5,
    projectileSpeed: 32,
    projectileLifetime: 1.3,
    projectileRadius: 0.13,
    projectileCap: 500,
    damageMin: 12,
    damageMax: 18,
    criticalChance: 0.12,
    criticalMultiplier: 2,
    knockbackSpeed: 7,
    knockbackDuration: 0.45,
    knockbackDecay: 9,
    effectLifetime: 0.65,
    effectCap: 100,
    killScore: 100,
    beatSurvivalScore: 2,
    fireEveryBeats: 1,
    beatsPerBar: 4,
});

export interface Projectile {
    id: number;
    shooterId: number;
    collisionMask: number;
    x: number;
    z: number;
    previousX: number;
    previousZ: number;
    velocityX: number;
    velocityZ: number;
    remainingLifetime: number;
    radius: number;
    damage: number;
    critical: boolean;
}

export interface CombatEffect {
    id: number;
    x: number;
    z: number;
    amount: number;
    critical: boolean;
    kind: "hit" | "kill" | "player-hit";
    expiresAt: number;
}

/** Transient facts returned by the fixed step; presentation owns their scheduling. */
export interface CombatEvent extends Vec2 {
    id: number;
    kind: CombatEffect["kind"] | "shot" | "spawn";
    amount: number;
    critical: boolean;
    simulationTime: number;
}

export interface CombatState {
    tuning: CombatTuning;
    enemies: Enemy[];
    projectiles: Projectile[];
    effects: CombatEffect[];
    health: number;
    score: number;
    kills: number;
    time: number;
    invulnerableUntil: number;
    defeated: boolean;
    randomState: number;
    nextId: number;
    eventSequence: number;
    lastBeatIndex: number;
    lastBarIndex: number;
    lastSpawnBar: number;
    lastAim: Vec2;
}

export interface CombatBeat {
    index: number;
    barIndex: number;
    isDownbeat?: boolean;
}

export interface CombatStep {
    killedIds: number[];
    playerDamaged: boolean;
    defeated: boolean;
    events: CombatEvent[];
}

export function createCombat(seed = 1, overrides: Partial<CombatTuning> = {}): CombatState {
    const tuning = { ...DEFAULT_COMBAT_TUNING, ...overrides };
    for (const [key, value] of Object.entries(tuning)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid combat setting: ${key}`);
    }
    if (tuning.damageMax < tuning.damageMin || tuning.criticalChance > 1
        || tuning.spawnInset + tuning.spawnBand >= tuning.arenaHalfExtent
        || tuning.fireEveryBeats < 1 || tuning.beatsPerBar < 1
        || tuning.waveIncreaseEveryBars < 1 || tuning.speedIncreaseEveryBars < 1
        || tuning.playerHealth < 1 || tuning.enemyHealth < 1) {
        throw new Error("Invalid combat tuning range");
    }
    return {
        tuning, enemies: [], projectiles: [], effects: [],
        health: tuning.playerHealth, score: 0, kills: 0, time: 0,
        invulnerableUntil: 0, defeated: false,
        randomState: seed >>> 0, nextId: 1, eventSequence: 0,
        lastBeatIndex: -1, lastBarIndex: -1, lastSpawnBar: -1,
        lastAim: { x: 0, z: -1 },
    };
}

/** Mulberry32: RNG state belongs to the session, never to a module or Math.random. */
export function combatRandom(state: CombatState): number {
    state.randomState = (state.randomState + 0x6D2B79F5) >>> 0;
    let value = state.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

export function spawnOnBeat(state: CombatState, beat: CombatBeat, player: Vec2): Enemy[] {
    const downbeat = beat.isDownbeat ?? beat.index % state.tuning.beatsPerBar === 0;
    if (state.defeated || !downbeat || beat.barIndex <= state.lastSpawnBar) return [];
    state.lastSpawnBar = beat.barIndex;
    const count = Math.min(
        waveSize(beat.barIndex, state.tuning),
        Math.max(0, state.tuning.enemyCap - state.enemies.length),
    );
    const spawned: Enemy[] = [];
    for (let i = 0; i < count; i++) {
        const point = findSpawnPosition(player, state.tuning, () => combatRandom(state));
        if (!point) break;
        const enemy = createEnemy(state.nextId++, point, beat.barIndex, state.tuning);
        state.enemies.push(enemy);
        spawned.push(enemy);
    }
    return spawned;
}

/**
 * Player fire sweeps against enemy group 2 only: no shooter, friendly player,
 * effects, or other projectiles. Arena walls are an outer boundary, not targets.
 */
export function fireProjectile(
    state: CombatState,
    player: Vec2,
    aim: Vec2,
    shooterId = 0,
): Projectile | undefined {
    if (state.defeated || state.projectiles.length >= state.tuning.projectileCap) return;
    const length = Math.hypot(aim.x, aim.z);
    if (Number.isFinite(length) && length > 0.00001) {
        state.lastAim = { x: aim.x / length, z: aim.z / length };
    }
    const direction = state.lastAim;
    const damageRoll = combatRandom(state);
    const critical = combatRandom(state) < state.tuning.criticalChance;
    const damage = Math.floor(
        state.tuning.damageMin + damageRoll * (state.tuning.damageMax - state.tuning.damageMin + 1),
    ) * (critical ? state.tuning.criticalMultiplier : 1);
    const muzzle = state.tuning.playerRadius + state.tuning.projectileRadius + 0.05;
    const x = player.x + direction.x * muzzle;
    const z = player.z + direction.z * muzzle;
    const projectile: Projectile = {
        id: state.nextId++, shooterId, collisionMask: ENEMY_COLLISION_GROUP,
        x, z, previousX: x, previousZ: z,
        velocityX: direction.x * state.tuning.projectileSpeed,
        velocityZ: direction.z * state.tuning.projectileSpeed,
        remainingLifetime: state.tuning.projectileLifetime,
        radius: state.tuning.projectileRadius,
        damage, critical,
    };
    state.projectiles.push(projectile);
    return projectile;
}

/** Commands must be recorded/injected for replay; live audio time is external input. */
export function onCombatBeat(state: CombatState, beat: CombatBeat, player: Vec2, aim: Vec2): CombatEvent[] {
    if (state.defeated || beat.index <= state.lastBeatIndex) return [];
    state.lastBeatIndex = beat.index;
    state.lastBarIndex = beat.barIndex;
    state.score += state.tuning.beatSurvivalScore;
    const events: CombatEvent[] = spawnOnBeat(state, beat, player).map(enemy => ({
        id: ++state.eventSequence, kind: "spawn", x: enemy.x, z: enemy.z,
        amount: 0, critical: false, simulationTime: state.time,
    }));
    if (beat.index % state.tuning.fireEveryBeats === 0) {
        const shot = fireProjectile(state, player, aim);
        if (shot) events.push({
            id: ++state.eventSequence, kind: "shot", x: shot.x, z: shot.z,
            amount: 0, critical: shot.critical, simulationTime: state.time,
        });
    }
    return events;
}

/** Fraction [0, 1] of the first intersection, including starting inside a circle. */
export function segmentCircleHit(start: Vec2, end: Vec2, center: Vec2, radius: number): number | undefined {
    const ox = start.x - center.x;
    const oz = start.z - center.z;
    const c = ox * ox + oz * oz - radius * radius;
    if (c <= 0) return 0;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-12) return;
    const b = 2 * (ox * dx + oz * dz);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
    return fraction >= 0 && fraction <= 1 ? fraction : undefined;
}

function addEffect(state: CombatState, effect: Omit<CombatEffect, "id" | "expiresAt">): void {
    if (state.tuning.effectCap === 0) return;
    state.effects.push({
        ...effect, id: state.nextId++, expiresAt: state.time + state.tuning.effectLifetime,
    });
    if (state.effects.length > state.tuning.effectCap) {
        state.effects.splice(0, state.effects.length - state.tuning.effectCap);
    }
}

/**
 * Fixed-tick order: accept published physics positions → sweep/hits → death →
 * contact → expiry. Passing positions makes physics authoritative; omission is
 * a CPU-only deterministic harness that integrates the same desired velocities.
 * Pause is implemented by the owner not calling this function.
 */
export function advanceCombat(
    state: CombatState,
    dt: number,
    player: Vec2,
    enemyPositions?: ReadonlyMap<number, Vec2>,
): CombatStep {
    const result: CombatStep = { killedIds: [], playerDamaged: false, defeated: state.defeated, events: [] };
    const feedback = (effect: Omit<CombatEffect, "id" | "expiresAt">) => {
        addEffect(state, effect);
        result.events.push({ ...effect, id: ++state.eventSequence, simulationTime: state.time });
    };
    if (state.defeated || !Number.isFinite(dt) || dt <= 0) return result;
    for (const enemy of state.enemies) {
        if (enemyPositions) {
            const position = enemyPositions.get(enemy.id);
            if (position) { enemy.x = position.x; enemy.z = position.z; }
        } else {
            const velocity = enemyVelocity(enemy, player, state);
            const limit = state.tuning.arenaHalfExtent - enemy.radius;
            enemy.x = Math.max(-limit, Math.min(limit, enemy.x + velocity.x * dt));
            enemy.z = Math.max(-limit, Math.min(limit, enemy.z + velocity.z * dt));
        }
    }
    state.time += dt;
    const survivingProjectiles: Projectile[] = [];
    for (const projectile of state.projectiles) {
        const travelTime = Math.min(dt, projectile.remainingLifetime);
        if (travelTime <= 0) continue;
        projectile.previousX = projectile.x;
        projectile.previousZ = projectile.z;
        const start = { x: projectile.x, z: projectile.z };
        const end = {
            x: projectile.x + projectile.velocityX * travelTime,
            z: projectile.z + projectile.velocityZ * travelTime,
        };
        let nearest: Enemy | undefined;
        let nearestFraction = Infinity;
        for (const enemy of state.enemies) {
            if (enemy.health <= 0 || enemy.id === projectile.shooterId
                || !(enemy.collisionGroup & projectile.collisionMask)) continue;
            const fraction = segmentCircleHit(start, end, enemy, enemy.radius + projectile.radius);
            if (fraction !== undefined && (fraction < nearestFraction
                || (fraction === nearestFraction && enemy.id < (nearest?.id ?? Infinity)))) {
                nearest = enemy;
                nearestFraction = fraction;
            }
        }
        if (nearest) {
            nearest.health = Math.max(0, nearest.health - projectile.damage);
            const speed = Math.hypot(projectile.velocityX, projectile.velocityZ);
            nearest.knockbackX = speed > 0 ? projectile.velocityX / speed * state.tuning.knockbackSpeed : 0;
            nearest.knockbackZ = speed > 0 ? projectile.velocityZ / speed * state.tuning.knockbackSpeed : 0;
            nearest.knockbackStartedAt = state.time;
            nearest.knockbackUntil = state.time + state.tuning.knockbackDuration;
            feedback({
                x: nearest.x, z: nearest.z, amount: projectile.damage,
                critical: projectile.critical, kind: nearest.health === 0 ? "kill" : "hit",
            });
            if (nearest.health === 0) {
                state.kills++;
                state.score += state.tuning.killScore;
                result.killedIds.push(nearest.id);
            }
            continue; // A consumed projectile can never hit a second target.
        }
        projectile.x = end.x;
        projectile.z = end.z;
        projectile.remainingLifetime -= dt;
        const outerLimit = state.tuning.arenaHalfExtent + 1;
        if (projectile.remainingLifetime > 0
            && Math.abs(projectile.x) <= outerLimit && Math.abs(projectile.z) <= outerLimit) {
            survivingProjectiles.push(projectile);
        }
    }
    state.projectiles = survivingProjectiles;
    state.enemies = state.enemies.filter((enemy) => enemy.health > 0);
    if (state.time >= state.invulnerableUntil) {
        for (const enemy of state.enemies) {
            const range = enemy.radius + state.tuning.playerRadius + state.tuning.contactExtraRange;
            if ((enemy.x - player.x) ** 2 + (enemy.z - player.z) ** 2 <= range * range) {
                state.health = Math.max(0, state.health - state.tuning.contactDamage);
                state.invulnerableUntil = state.time + state.tuning.invulnerabilitySeconds;
                result.playerDamaged = true;
                feedback({
                    ...player, amount: state.tuning.contactDamage, critical: false, kind: "player-hit",
                });
                state.defeated = state.health === 0;
                break;
            }
        }
    }
    state.effects = state.effects.filter((effect) => effect.expiresAt > state.time);
    result.defeated = state.defeated;
    return result;
}
