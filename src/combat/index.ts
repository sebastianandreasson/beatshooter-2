import {
    createEnemy, enemyKindForSpawn, enemyVelocity, ENEMY_COLLISION_GROUP,
    findArenaSpawnPosition, findSpawnPosition, waveSize,
    type Enemy,
} from "../enemies";
import {
    advanceExperience, createExperience, dropExperience, type ExperienceState,
} from "../experience/state";
import {
    createPlayerStats, recordPlayerHit, recordPlayerShot, rollPlayerDamage,
    type PlayerStatsState, type PlayerStatsValues,
} from "../player-stats";
import { createUpgradeState, queueUpgradeLevels, type UpgradeState } from "../upgrades";

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
    /** Initial-health compatibility override. Runtime maximum lives in playerStats. */
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
    enemyProjectileSpeed: number;
    enemyProjectileLifetime: number;
    enemyProjectileRadius: number;
    enemyProjectileDamage: number;
    enemyProjectileCap: number;
    rangerStopDistance: number;
    rangerFireRange: number;
    spinnerTurnRadians: number;
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
    enemyProjectileSpeed: 9,
    enemyProjectileLifetime: 5,
    enemyProjectileRadius: 0.2,
    enemyProjectileDamage: 10,
    enemyProjectileCap: 120,
    rangerStopDistance: 6,
    rangerFireRange: 7,
    spinnerTurnRadians: Math.PI / 6,
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
    bouncesRemaining: number;
    hitEnemyIds: number[];
    waitingForBounce: boolean;
    lastBounceBeat: number;
}

export interface CombatEffect {
    id: number;
    x: number;
    z: number;
    amount: number;
    critical: boolean;
    /** Stable enemy identity survives death/removal for impact presentation. */
    targetId?: number;
    kind: "hit" | "kill" | "player-hit";
    expiresAt: number;
}

/** Transient facts returned by the fixed step; presentation owns their scheduling. */
export interface CombatEvent extends Vec2 {
    id: number;
    kind: CombatEffect["kind"] | "shot" | "spawn" | "level-up";
    amount: number;
    critical: boolean;
    targetId?: number;
    simulationTime: number;
}

/** A visible arrival reservation, not yet a target, attacker or physics body. */
export interface PendingEnemySpawn {
    enemy: Enemy;
    startTime: number;
    endTime: number;
    activateBeat: number;
}

export interface CombatState {
    tuning: CombatTuning;
    enemies: Enemy[];
    pendingSpawns: PendingEnemySpawn[];
    projectiles: Projectile[];
    effects: CombatEffect[];
    experience: ExperienceState;
    playerStats: PlayerStatsState;
    upgrades: UpgradeState;
    regenerationDueAt: number;
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
    lastEnemyAttackBar: number;
    lastAim: Vec2;
}

export interface CombatBeat {
    index: number;
    barIndex: number;
    isDownbeat?: boolean;
    /** Authored song timestamp, unaffected by pause duration or playback rate. */
    time?: number;
    /** Next authored timestamp; null means the track has no following beat. */
    nextBeatTime?: number | null;
}

export interface CombatStep {
    killedIds: number[];
    playerDamaged: boolean;
    defeated: boolean;
    events: CombatEvent[];
}

export function createCombat(
    seed = 1,
    overrides: Partial<CombatTuning> = {},
    playerStats: Partial<PlayerStatsValues> = {},
): CombatState {
    const tuning = { ...DEFAULT_COMBAT_TUNING, ...overrides };
    for (const [key, value] of Object.entries(tuning)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid combat setting: ${key}`);
    }
    if (tuning.spawnInset + tuning.spawnBand >= tuning.arenaHalfExtent
        || tuning.fireEveryBeats < 1 || tuning.beatsPerBar < 1
        || tuning.waveIncreaseEveryBars < 1 || tuning.speedIncreaseEveryBars < 1
        || tuning.playerHealth < 1 || tuning.enemyHealth < 1
        || tuning.rangerFireRange < tuning.rangerStopDistance) {
        throw new Error("Invalid combat tuning range");
    }
    const stats = createPlayerStats({ maxHealth: tuning.playerHealth, ...playerStats });
    return {
        tuning, enemies: [], pendingSpawns: [], projectiles: [], effects: [], experience: createExperience(),
        playerStats: stats, upgrades: createUpgradeState(seed),
        regenerationDueAt: stats.effective.healthRegen > 0 ? 5 : Infinity,
        health: stats.effective.maxHealth, score: 0, kills: 0, time: 0,
        invulnerableUntil: 0, defeated: false,
        randomState: seed >>> 0, nextId: 1, eventSequence: 0,
        lastBeatIndex: -1, lastBarIndex: -1, lastSpawnBar: -1, lastEnemyAttackBar: -1,
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

/** Reserve a wave's positions; the next authored beat makes its enemies live. */
export function spawnOnBeat(state: CombatState, beat: CombatBeat, player: Vec2): Enemy[] {
    const downbeat = beat.isDownbeat ?? beat.index % state.tuning.beatsPerBar === 0;
    if (state.defeated || !downbeat || beat.barIndex <= state.lastSpawnBar) return [];
    state.lastSpawnBar = beat.barIndex;
    const startTime = beat.time ?? state.time;
    // Pure command callers may omit timestamps. Live sessions always supply the
    // following authored beat; never invent an arrival across a detection gap
    // or after the final beat of a track.
    const endTime = beat.nextBeatTime === undefined ? startTime + 0.5 : beat.nextBeatTime;
    if (endTime === null || !Number.isFinite(startTime) || !Number.isFinite(endTime)
        || endTime <= startTime || endTime - startTime > 3.05) return [];
    const count = Math.min(
        waveSize(beat.barIndex, state.tuning),
        Math.max(0, state.tuning.enemyCap - state.enemies.length - state.pendingSpawns.length),
    );
    const spawned: Enemy[] = [];
    for (let i = 0; i < count; i++) {
        const kind = enemyKindForSpawn(beat.barIndex, i);
        const findPosition = kind === "spinner" ? findArenaSpawnPosition : findSpawnPosition;
        const point = findPosition(player, state.tuning, () => combatRandom(state));
        if (!point) break;
        const heading = kind === "spinner" ? combatRandom(state) * Math.PI * 2 : 0;
        const enemy = createEnemy(state.nextId++, point, beat.barIndex, state.tuning, kind, heading);
        state.pendingSpawns.push({ enemy, startTime, endTime, activateBeat: beat.index + 1 });
        spawned.push(enemy);
    }
    return spawned;
}

function activateEnemySpawns(state: CombatState, beat: CombatBeat): void {
    const waiting: PendingEnemySpawn[] = [];
    for (const spawn of state.pendingSpawns) {
        if (beat.index < spawn.activateBeat
            || (beat.time !== undefined && beat.time + 1e-8 < spawn.endTime)) {
            waiting.push(spawn);
        } else if (state.enemies.length < state.tuning.enemyCap) {
            state.enemies.push(spawn.enemy);
        }
    }
    state.pendingSpawns = waiting;
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
    // Snapshot the current effective stats at firing time. Later modifiers
    // affect future shots, never projectiles that are already in flight.
    const { damage, critical } = rollPlayerDamage(
        state.playerStats, combatRandom(state), combatRandom(state),
    );
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
        bouncesRemaining: state.playerStats.effective.bounces,
        hitEnemyIds: [], waitingForBounce: false, lastBounceBeat: state.lastBeatIndex,
    };
    state.projectiles.push(projectile);
    recordPlayerShot(state.playerStats);
    return projectile;
}

/** Even counts straddle the aim; odd counts retain a central projectile. */
export function fireVolley(state: CombatState, player: Vec2, aim: Vec2): Projectile[] {
    if (state.defeated) return [];
    const length = Math.hypot(aim.x, aim.z);
    const direction = Number.isFinite(length) && length > 0.00001
        ? { x: aim.x / length, z: aim.z / length } : { ...state.lastAim };
    const count = Math.min(
        state.playerStats.effective.projectileCount,
        Math.max(0, Math.floor(state.tuning.projectileCap - state.projectiles.length)),
    );
    const spread = Math.min(Math.PI / 3, Math.max(0, count - 1) * Math.PI / 15);
    const shots: Projectile[] = [];
    for (let index = 0; index < count; index++) {
        const angle = count <= 1 ? 0 : -spread / 2 + index * spread / (count - 1);
        const cosine = Math.cos(angle), sine = Math.sin(angle);
        const shot = fireProjectile(state, player, {
            x: direction.x * cosine - direction.z * sine,
            z: direction.x * sine + direction.z * cosine,
        });
        if (shot) shots.push(shot);
    }
    state.lastAim = direction;
    return shots;
}

function fireBarrage(state: CombatState, player: Vec2): Projectile[] {
    const aim = { ...state.lastAim };
    const count = Math.min(
        state.playerStats.effective.barrageCount,
        Math.max(0, Math.floor(state.tuning.projectileCap - state.projectiles.length)),
    );
    const shots: Projectile[] = [];
    const offset = Math.atan2(aim.z, aim.x);
    for (let index = 0; index < count; index++) {
        const angle = offset + index * Math.PI * 2 / count;
        const shot = fireProjectile(state, player, { x: Math.cos(angle), z: Math.sin(angle) });
        if (shot) shots.push(shot);
    }
    state.lastAim = aim;
    return shots;
}

function releaseRicochets(state: CombatState, beat: CombatBeat): void {
    const retired = new Set<number>();
    for (const projectile of state.projectiles) {
        if (!projectile.waitingForBounce || projectile.lastBounceBeat >= beat.index) continue;
        let target: Enemy | undefined;
        let distance = Infinity;
        for (const enemy of state.enemies) {
            if (enemy.health <= 0 || projectile.hitEnemyIds.includes(enemy.id)
                || enemy.id === projectile.shooterId
                || !(enemy.collisionGroup & projectile.collisionMask)) continue;
            const squared = (enemy.x - projectile.x) ** 2 + (enemy.z - projectile.z) ** 2;
            if (squared < distance || (squared === distance && enemy.id < (target?.id ?? Infinity))) {
                target = enemy;
                distance = squared;
            }
        }
        if (!target || projectile.bouncesRemaining <= 0) {
            retired.add(projectile.id);
            continue;
        }
        const dx = target.x - projectile.x, dz = target.z - projectile.z;
        const length = Math.hypot(dx, dz);
        projectile.velocityX = length > 0 ? dx / length * state.tuning.projectileSpeed : 0;
        projectile.velocityZ = length > 0 ? dz / length * state.tuning.projectileSpeed : 0;
        projectile.bouncesRemaining--;
        projectile.waitingForBounce = false;
        projectile.lastBounceBeat = beat.index;
        projectile.remainingLifetime = state.tuning.projectileLifetime;
    }
    if (retired.size > 0) state.projectiles = state.projectiles.filter(shot => !retired.has(shot.id));
}

function enemyProjectileSlots(state: CombatState): number {
    const hostile = state.projectiles.filter(shot => shot.collisionMask & PLAYER_COLLISION_GROUP).length;
    return Math.min(state.tuning.projectileCap - 1 - state.projectiles.length,
        state.tuning.enemyProjectileCap - hostile);
}

/** Hostile fire has its own budget, leaving at least one slot for player fire. */
export function fireEnemyProjectile(state: CombatState, enemy: Enemy, direction: Vec2): Projectile | undefined {
    const length = Math.hypot(direction.x, direction.z);
    if (state.defeated || enemy.health <= 0 || !Number.isFinite(length) || length < 0.00001
        || enemyProjectileSlots(state) < 1) return;
    const dx = direction.x / length, dz = direction.z / length;
    const muzzle = enemy.radius + state.tuning.enemyProjectileRadius + 0.05;
    const x = enemy.x + dx * muzzle, z = enemy.z + dz * muzzle;
    const projectile: Projectile = {
        id: state.nextId++, shooterId: enemy.id, collisionMask: PLAYER_COLLISION_GROUP,
        x, z, previousX: x, previousZ: z,
        velocityX: dx * state.tuning.enemyProjectileSpeed,
        velocityZ: dz * state.tuning.enemyProjectileSpeed,
        remainingLifetime: state.tuning.enemyProjectileLifetime,
        radius: state.tuning.enemyProjectileRadius,
        damage: state.tuning.enemyProjectileDamage, critical: false,
        bouncesRemaining: 0, hitEnemyIds: [], waitingForBounce: false, lastBounceBeat: -1,
    };
    state.projectiles.push(projectile);
    return projectile;
}

function attackOnDownbeat(state: CombatState, beat: CombatBeat, player: Vec2): void {
    const downbeat = beat.isDownbeat ?? beat.index % state.tuning.beatsPerBar === 0;
    if (!downbeat || beat.barIndex <= state.lastEnemyAttackBar) return;
    state.lastEnemyAttackBar = beat.barIndex;
    for (const enemy of state.enemies) {
        // Wait a bar from the arrival telegraph before a shooter's first shot.
        if (enemy.health <= 0 || enemy.spawnBar >= beat.barIndex) continue;
        if (enemy.kind === "spinner") {
            enemy.heading = (enemy.heading + state.tuning.spinnerTurnRadians) % (Math.PI * 2);
            if (enemyProjectileSlots(state) < 3) continue;
            for (let ray = 0; ray < 3; ray++) {
                const angle = enemy.heading + ray * Math.PI * 2 / 3;
                fireEnemyProjectile(state, enemy, { x: Math.sin(angle), z: Math.cos(angle) });
            }
        } else if (enemy.kind === "ranger") {
            const dx = player.x - enemy.x, dz = player.z - enemy.z;
            if (Math.hypot(dx, dz) <= state.tuning.rangerFireRange) {
                enemy.heading = Math.atan2(dx, dz);
                fireEnemyProjectile(state, enemy, { x: dx, z: dz });
            }
        }
    }
}

/** Commands must be recorded/injected for replay; live audio time is external input. */
export function onCombatBeat(state: CombatState, beat: CombatBeat, player: Vec2, aim: Vec2): CombatEvent[] {
    if (state.defeated || beat.index <= state.lastBeatIndex) return [];
    state.lastBeatIndex = beat.index;
    state.lastBarIndex = beat.barIndex;
    state.score += state.tuning.beatSurvivalScore;
    activateEnemySpawns(state, beat);
    const events: CombatEvent[] = spawnOnBeat(state, beat, player).map(enemy => ({
        id: ++state.eventSequence, kind: "spawn", x: enemy.x, z: enemy.z,
        amount: 0, critical: false, simulationTime: state.time,
    }));
    releaseRicochets(state, beat);
    const beatTime = beat.time ?? state.time;
    if (Number.isFinite(beatTime) && beatTime >= state.regenerationDueAt
        && state.playerStats.effective.healthRegen > 0) {
        state.health = Math.min(
            state.playerStats.effective.maxHealth,
            state.health + state.playerStats.effective.healthRegen,
        );
        // A detection gap never releases a backlog of heals on one beat.
        state.regenerationDueAt = beatTime + 5;
    }
    const shots: Projectile[] = [];
    if (beat.index % state.tuning.fireEveryBeats === 0) {
        shots.push(...fireVolley(state, player, aim));
    }
    // Barrage requires an explicitly authored accent, never an inferred grouping.
    if (beat.isDownbeat === true) shots.push(...fireBarrage(state, player));
    const shot = shots[0];
    if (shot) {
        events.push({
            id: ++state.eventSequence, kind: "shot", x: shot.x, z: shot.z,
            amount: shots.length, critical: shot.critical, simulationTime: state.time,
        });
    }
    attackOnDownbeat(state, beat, player);
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
    previousPlayer: Vec2 = player,
): CombatStep {
    const result: CombatStep = { killedIds: [], playerDamaged: false, defeated: state.defeated, events: [] };
    const feedback = (effect: Omit<CombatEffect, "id" | "expiresAt">) => {
        addEffect(state, effect);
        result.events.push({ ...effect, id: ++state.eventSequence, simulationTime: state.time });
    };
    if (state.defeated || !Number.isFinite(dt) || dt <= 0) return result;
    const damagePlayer = (amount: number, hitTime = state.time) => {
        if (state.defeated || amount <= 0 || hitTime < state.invulnerableUntil) return;
        state.health = Math.max(0, state.health - amount);
        state.invulnerableUntil = hitTime + state.tuning.invulnerabilitySeconds;
        result.playerDamaged = true;
        feedback({ ...player, amount, critical: false, kind: "player-hit" });
        state.defeated = state.health === 0;
    };
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
        if (enemy.kind === "ranger") {
            enemy.heading = Math.atan2(player.x - enemy.x, player.z - enemy.z);
        }
    }
    state.time += dt;
    const survivingProjectiles: Projectile[] = [];
    for (const projectile of state.projectiles) {
        if (projectile.waitingForBounce) {
            projectile.previousX = projectile.x;
            projectile.previousZ = projectile.z;
            survivingProjectiles.push(projectile);
            continue;
        }
        const travelTime = Math.min(dt, projectile.remainingLifetime);
        if (travelTime <= 0) continue;
        projectile.previousX = projectile.x;
        projectile.previousZ = projectile.z;
        const start = { x: projectile.x, z: projectile.z };
        const end = {
            x: projectile.x + projectile.velocityX * travelTime,
            z: projectile.z + projectile.velocityZ * travelTime,
        };
        if (projectile.collisionMask & PLAYER_COLLISION_GROUP) {
            // Relative motion also catches a dashing player crossing a slow bullet.
            // A shot expiring partway through this tick sees only that part of motion.
            const fraction = travelTime / dt;
            const playerEnd = {
                x: previousPlayer.x + (player.x - previousPlayer.x) * fraction,
                z: previousPlayer.z + (player.z - previousPlayer.z) * fraction,
            };
            const hit = segmentCircleHit(
                { x: start.x - previousPlayer.x, z: start.z - previousPlayer.z },
                { x: end.x - playerEnd.x, z: end.z - playerEnd.z },
                { x: 0, z: 0 }, state.tuning.playerRadius + projectile.radius,
            );
            if (hit !== undefined) {
                damagePlayer(projectile.damage, state.time - dt + hit * travelTime);
                continue; // Invulnerability absorbs the shot; it cannot hit again later.
            }
        }
        let nearest: Enemy | undefined;
        let nearestFraction = Infinity;
        for (const enemy of state.enemies) {
            if (!(projectile.collisionMask & ENEMY_COLLISION_GROUP)
                || enemy.health <= 0 || enemy.id === projectile.shooterId
                || projectile.hitEnemyIds.includes(enemy.id)
                || !(enemy.collisionGroup & projectile.collisionMask)) continue;
            const fraction = segmentCircleHit(start, end, enemy, enemy.radius + projectile.radius);
            if (fraction !== undefined && (fraction < nearestFraction
                || (fraction === nearestFraction && enemy.id < (nearest?.id ?? Infinity)))) {
                nearest = enemy;
                nearestFraction = fraction;
            }
        }
        if (nearest) {
            const appliedDamage = Math.min(nearest.health, projectile.damage);
            nearest.health = Math.max(0, nearest.health - projectile.damage);
            recordPlayerHit(state.playerStats, appliedDamage, projectile.critical);
            const speed = Math.hypot(projectile.velocityX, projectile.velocityZ);
            nearest.knockbackX = speed > 0 ? projectile.velocityX / speed * state.tuning.knockbackSpeed : 0;
            nearest.knockbackZ = speed > 0 ? projectile.velocityZ / speed * state.tuning.knockbackSpeed : 0;
            nearest.knockbackStartedAt = state.time;
            nearest.knockbackUntil = state.time + state.tuning.knockbackDuration;
            feedback({
                x: nearest.x, z: nearest.z, amount: projectile.damage,
                targetId: nearest.id,
                critical: projectile.critical, kind: nearest.health === 0 ? "kill" : "hit",
            });
            if (nearest.health === 0) {
                state.kills++;
                state.score += state.tuning.killScore;
                result.killedIds.push(nearest.id);
                dropExperience(state.experience, nearest);
            }
            projectile.hitEnemyIds.push(nearest.id);
            if (projectile.bouncesRemaining > 0) {
                projectile.x = start.x + (end.x - start.x) * nearestFraction;
                projectile.z = start.z + (end.z - start.z) * nearestFraction;
                projectile.previousX = projectile.x;
                projectile.previousZ = projectile.z;
                projectile.velocityX = 0;
                projectile.velocityZ = 0;
                projectile.waitingForBounce = true;
                projectile.lastBounceBeat = state.lastBeatIndex;
                survivingProjectiles.push(projectile);
            }
            continue; // Another impact is possible only after a later musical beat.
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
                damagePlayer(state.tuning.contactDamage);
                break;
            }
        }
    }
    if (!state.defeated) {
        const progress = advanceExperience(state.experience, dt, player, previousPlayer);
        if (progress.levelsGained > 0) {
            queueUpgradeLevels(state.upgrades, state.experience.level);
            result.events.push({
                id: ++state.eventSequence, kind: "level-up", ...player,
                amount: state.experience.level, critical: false, simulationTime: state.time,
            });
        }
    }
    state.effects = state.effects.filter((effect) => effect.expiresAt > state.time);
    result.defeated = state.defeated;
    return result;
}
