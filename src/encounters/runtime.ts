import type { CombatBeat, CombatState, Vec2 } from "../combat";
import { createEnemy, type Enemy, type EnemyKind } from "../enemies";
import { validateTimeline, type Beat } from "../rhythm/timeline";
import {
    advanceHazards, createHazards, MAX_AUTHORED_GAP, warningWindow,
    type HazardState, type WarningWindow,
} from "../hazards/state";
import { ENCOUNTERS, isEncounterId, type EncounterId } from "./catalog";

export interface EncounterConfig {
    id: EncounterId;
    stageIndex: number;
    duration: number;
    beats: readonly Beat[];
    seed: number;
    entryNextLevelXp: number;
}
export interface EncounterEnemy {
    xp: number;
    group: number;
    elite: boolean;
    scaledHealth?: number;
    scaledCapacity?: number;
    healthFraction?: number;
}
export interface RangerWarning extends WarningWindow {
    enemyId: number;
    origin: Vec2;
    direction: Vec2;
}
export interface EncounterState extends EncounterConfig {
    ordinaryXp: number;
    eliteDefeated: boolean;
    eliteId?: number;
    eliteWindow?: WarningWindow;
    enemies: Map<number, EncounterEnemy>;
    rangerWarnings: Map<number, RangerWarning>;
    hazards: HazardState;
    randomState: number;
    position: number;
    enemySpeed: number;
    healthMultiplier: number;
    spawnBudget: number;
    lastBudgetIndex: number;
    lastBudgetTime: number;
    lastWaveAt: number;
    waveSequence: number;
    spawnSequence: number;
    stopped: boolean;
}

export function configureEncounter(combat: CombatState, config: EncounterConfig): EncounterState {
    if (!isEncounterId(config.id) || !Number.isSafeInteger(config.stageIndex) || config.stageIndex < 0
        || !Number.isSafeInteger(config.entryNextLevelXp) || config.entryNextLevelXp < 1) {
        throw new RangeError("Invalid campaign encounter configuration.");
    }
    validateTimeline(config.beats, config.duration);
    const encounter: EncounterState = {
        ...config, ordinaryXp: 0, eliteDefeated: false,
        enemies: new Map(), rangerWarnings: new Map(), hazards: createHazards(config.seed),
        randomState: config.seed >>> 0, position: 0, enemySpeed: combat.tuning.enemySpeed,
        healthMultiplier: 1, spawnBudget: 2, lastBudgetIndex: -1, lastBudgetTime: 0,
        lastWaveAt: -Infinity, waveSequence: 0, spawnSequence: 0, stopped: false,
    };
    combat.encounter = encounter;
    advanceEncounterDifficulty(combat, 0);
    return encounter;
}

/** A new combat state is used for each song; stopping also makes settlement safe. */
export function stopEncounter(combat: CombatState): void {
    const encounter = combat.encounter;
    if (!encounter) return;
    encounter.stopped = true;
    encounter.rangerWarnings.clear();
    encounter.hazards.grid = undefined;
    encounter.hazards.pendingStrikes.length = 0;
}

export function campaignProfile(stageIndex: number, position: number, duration: number) {
    // Every completed song raises the baseline, including playlists beyond ten songs.
    const stage = Math.max(0, stageIndex);
    const progress = Math.max(0, Math.min(1, position / Math.max(0.001, duration)));
    const stagePressure = 1 + stage * 0.35;
    return {
        progress,
        health: stagePressure * (1 + progress * 0.9),
        speedGain: stage * 0.08 + progress * 0.9,
        // Twice the old 0.44/s opening, rising to 2.5x within each song.
        spawnRate: 0.88 * stagePressure * (1 + progress * 1.5),
    };
}

export function scaleEncounterEnemy(enemy: Enemy, multiplier: number, variant?: EncounterEnemy): void {
    const capacity = Math.max(1, Math.round(enemy.baseHealth * multiplier));
    // Reuse the exact wound fraction through difficulty-only changes. Repeated
    // rounding at each +1 capacity must neither heal nor erode the same wound.
    const fraction = variant?.scaledHealth === enemy.health && variant.scaledCapacity === enemy.maxHealth
        ? variant.healthFraction! : enemy.maxHealth > 0 ? enemy.health / enemy.maxHealth : 0;
    enemy.health = enemy.health > 0 ? Math.max(1, Math.round(capacity * fraction)) : 0;
    enemy.maxHealth = capacity;
    if (variant) {
        variant.scaledHealth = enemy.health;
        variant.scaledCapacity = capacity;
        variant.healthFraction = fraction;
    }
}

export function advanceEncounterDifficulty(combat: CombatState, position: number): void {
    const encounter = combat.encounter;
    if (!encounter || encounter.stopped || combat.defeated || !Number.isFinite(position) || position < 0) return;
    encounter.position = Math.max(encounter.position, Math.min(encounter.duration, position));
    const profile = campaignProfile(encounter.stageIndex, encounter.position, encounter.duration);
    encounter.healthMultiplier = profile.health;
    encounter.enemySpeed = Math.min(combat.tuning.enemyMaxSpeed, combat.tuning.enemySpeed + profile.speedGain);
    for (const enemy of combat.enemies) scaleEncounterEnemy(enemy, profile.health, encounter.enemies.get(enemy.id));
    for (const pending of combat.pendingSpawns) scaleEncounterEnemy(pending.enemy, profile.health, encounter.enemies.get(pending.enemy.id));
}

function random(state: EncounterState): number {
    state.randomState = (state.randomState + 0x6D2B79F5) >>> 0;
    let value = state.randomState;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

/** Integrate actual song intervals, never wall time, frame count or bar count. */
export function advanceEncounterBeat(combat: CombatState, beat: CombatBeat): void {
    const e = combat.encounter;
    if (!e || e.stopped || combat.defeated || beat.index <= e.lastBudgetIndex) return;
    const authored = e.beats[beat.index];
    if (!authored || authored.time !== beat.time) return;
    const dt = authored.time - e.lastBudgetTime;
    if (e.lastBudgetIndex >= 0 && beat.index === e.lastBudgetIndex + 1 && dt <= MAX_AUTHORED_GAP) {
        const rate = campaignProfile(e.stageIndex, (authored.time + e.lastBudgetTime) / 2, e.duration).spawnRate;
        const eliteAlive = e.eliteId !== undefined && !e.eliteDefeated;
        // Reserve at most one arena's worth. A fixed five-unit bucket clipped
        // later stages and slow songs before their stronger waves could release.
        const capacity = combat.tuning.enemyCap / (e.id === "swarm-nest" ? 2 : 1);
        e.spawnBudget = Math.min(capacity, e.spawnBudget + dt * rate * ENCOUNTERS[e.id].density * (eliteAlive ? 0.55 : 1));
    } else if (e.lastBudgetIndex >= 0) {
        // Do not save up spawns or fire delayed warnings across a missing chart interval.
        e.spawnBudget = 0;
        e.rangerWarnings.clear();
        e.hazards.grid = undefined;
        e.hazards.pendingStrikes.length = 0;
        for (const pending of combat.pendingSpawns) e.enemies.delete(pending.enemy.id);
        combat.pendingSpawns.length = 0;
    }
    e.lastBudgetIndex = beat.index;
    e.lastBudgetTime = authored.time;
    advanceEncounterDifficulty(combat, authored.time);
    if (e.id === "pulse-grid") advanceHazards(e.hazards, e.beats, authored, e.duration, e.stageIndex);
}

function spawnPosition(
    combat: CombatState, player: Vec2, kind: EnemyKind, sector: number,
): Vec2 | undefined {
    const e = combat.encounter!, t = combat.tuning;
    const edge = t.arenaHalfExtent - t.spawnInset;
    const existing = [...combat.enemies, ...combat.pendingSpawns.map(item => item.enemy)];
    for (let attempt = 0; attempt < 24; attempt++) {
        // Stationary crossfire uses four separated quadrants; approach sectors
        // alternate for moving enemies and retain the established safety radius.
        const along = (random(e) * 2 - 1) * Math.min(12, edge);
        const depth = edge - random(e) * t.spawnBand;
        const side = (sector + Math.floor(attempt / 6)) % 4;
        const point = kind === "spinner"
            ? { x: (side % 2 === 0 ? -1 : 1) * (7 + random(e) * 5),
                z: (side < 2 ? -1 : 1) * (7 + random(e) * 5) }
            : side === 0 ? { x: -depth, z: along } : side === 1 ? { x: depth, z: along }
            : side === 2 ? { x: along, z: -depth } : { x: along, z: depth };
        if (Math.hypot(point.x - player.x, point.z - player.z) < t.spawnSafetyRadius) continue;
        if (existing.some(enemy => Math.hypot(enemy.x - point.x, enemy.z - point.z) < (kind === "spinner" ? 4 : 1.3))) continue;
        return point;
    }
}

function reserve(
    combat: CombatState, beat: CombatBeat, player: Vec2, kind: EnemyKind,
    window: WarningWindow | undefined, elite: boolean,
): Enemy | undefined {
    const e = combat.encounter!, t = combat.tuning;
    if (combat.enemies.length + combat.pendingSpawns.length >= t.enemyCap) return;
    const point = spawnPosition(combat, player, kind, e.waveSequence % 4);
    if (!point) return;
    const enemy = createEnemy(combat.nextId++, point, beat.barIndex, t, kind, random(e) * Math.PI * 2);
    if (elite) {
        enemy.radius *= 1.5;
        enemy.baseHealth *= 4;
    } else if (e.id === "swarm-nest") {
        enemy.baseHealth = Math.max(1, Math.round(enemy.baseHealth * 0.6));
    }
    scaleEncounterEnemy(enemy, e.healthMultiplier);
    e.enemies.set(enemy.id, {
        xp: e.id === "swarm-nest" ? Math.max(1, Math.floor(combat.experience.tuning.dropValue / 2))
            : combat.experience.tuning.dropValue,
        group: e.spawnSequence++ % 2, elite,
    });
    combat.pendingSpawns.push({
        enemy, startTime: window?.startTime ?? beat.time!,
        endTime: window?.strikeTime ?? beat.nextBeatTime!,
        activateBeat: window?.strikeIndex ?? beat.index + 1,
    });
    return enemy;
}

/** Called only at eligible downbeats by the existing spawn command. */
export function spawnEncounterWave(combat: CombatState, beat: CombatBeat, player: Vec2): Enemy[] {
    const e = combat.encounter!;
    if (e.stopped || combat.defeated || beat.isDownbeat !== true || beat.time === undefined) return [];
    const spawned: Enemy[] = [];
    if (e.id === "elite-hunt" && e.eliteId === undefined && beat.time >= Math.min(12, e.duration * 0.22)) {
        const window = warningWindow(e.beats, beat.index, e.duration);
        if (window) {
            const elite = reserve(combat, beat, player, "spinner", window, true);
            if (elite) { e.eliteId = elite.id; e.eliteWindow = window; spawned.push(elite); }
        }
    }
    if (beat.time - e.lastWaveAt < 1) return spawned;
    const units = Math.floor(e.spawnBudget);
    if (!units) return spawned;
    e.lastWaveAt = beat.time;
    e.spawnBudget -= units; // Full arenas discard their budget rather than releasing a backlog.
    const count = Math.min(
        combat.tuning.enemyCap - combat.enemies.length - combat.pendingSpawns.length,
        units * (e.id === "swarm-nest" ? 2 : 1),
    );
    for (let slot = 0; slot < count; slot++) {
        const ordinal = e.spawnSequence;
        let kind: EnemyKind = e.id === "swarm-nest" ? "chaser"
            : e.id === "marksman-outpost" ? (ordinal % 5 === 4 ? "chaser" : "ranger")
            : e.id === "spinner-crossfire" ? (ordinal % 3 === 2 ? "chaser" : "spinner")
            : (["chaser", "ranger", "spinner"] as const)[(e.waveSequence + slot) % 3]!;
        const live = [...combat.enemies, ...combat.pendingSpawns.map(item => item.enemy)];
        // Ranged formations remain bounded even during long tracks.
        if (kind === "spinner" && live.filter(enemy => enemy.kind === "spinner").length >= 4) kind = "chaser";
        if (kind === "ranger" && live.filter(enemy => enemy.kind === "ranger").length >= 6) kind = "chaser";
        const enemy = reserve(combat, beat, player, kind, undefined, false);
        if (enemy) spawned.push(enemy);
    }
    e.waveSequence++;
    return spawned;
}

/** No acquisition or aim update occurs after a warning is committed. */
export function attackEncounterEnemies(
    combat: CombatState, beat: CombatBeat, player: Vec2,
    fire: (enemy: Enemy, direction: Vec2) => unknown,
    slots: () => number,
): void {
    const e = combat.encounter!;
    if (e.stopped) return;
    for (const [id, warning] of e.rangerWarnings) {
        const enemy = combat.enemies.find(item => item.id === id && item.health > 0);
        if (!enemy || beat.index > warning.strikeIndex) { e.rangerWarnings.delete(id); continue; }
        if (beat.index === warning.strikeIndex) {
            fire({ ...enemy, ...warning.origin }, warning.direction);
            e.rangerWarnings.delete(id);
        }
    }
    for (const enemy of combat.enemies) {
        if (enemy.health <= 0 || enemy.spawnBar >= beat.barIndex) continue;
        const variant = e.enemies.get(enemy.id);
        if (enemy.kind === "spinner") {
            // Six rays repeat every 60 degrees: half-sized bar turns make
            // consecutive two-bar elite volleys alternate by 30 degrees.
            enemy.heading = (enemy.heading + combat.tuning.spinnerTurnRadians * (variant?.elite ? 0.5 : 1)) % (Math.PI * 2);
            if (e.id === "spinner-crossfire" && variant?.group !== beat.barIndex % 2) continue;
            if (variant?.elite && beat.barIndex % 2 !== 0) continue;
            const rays = variant?.elite ? 6 : 3;
            if (slots() < rays) continue;
            for (let ray = 0; ray < rays; ray++) {
                const angle = enemy.heading + ray * Math.PI * 2 / rays;
                fire(enemy, { x: Math.sin(angle), z: Math.cos(angle) });
            }
        } else if (enemy.kind === "ranger") {
            if (e.rangerWarnings.has(enemy.id)) continue;
            const dx = player.x - enemy.x, dz = player.z - enemy.z, length = Math.hypot(dx, dz);
            if (length > combat.tuning.rangerFireRange || length < 0.00001) continue;
            enemy.heading = Math.atan2(dx, dz);
            if (e.id === "marksman-outpost") {
                const window = warningWindow(e.beats, beat.index, e.duration);
                if (window && e.rangerWarnings.size < 6) {
                    e.rangerWarnings.set(enemy.id, {
                        ...window, enemyId: enemy.id, origin: { x: enemy.x, z: enemy.z },
                        direction: { x: dx / length, z: dz / length },
                    });
                }
            } else fire(enemy, { x: dx, z: dz });
        }
    }
}

/** Called once for an actual kill; completion settlement pays the separate bonus. */
export function encounterKillXp(combat: CombatState, enemy: Enemy): number {
    const e = combat.encounter;
    if (!e) return combat.experience.tuning.dropValue;
    const variant = e.enemies.get(enemy.id);
    const xp = variant?.xp ?? combat.experience.tuning.dropValue;
    if (variant?.elite) e.eliteDefeated = true;
    e.ordinaryXp += xp;
    e.enemies.delete(enemy.id);
    e.rangerWarnings.delete(enemy.id);
    return xp;
}
