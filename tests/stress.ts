/**
 * Explicit CPU benchmark, intentionally outside all test-discovery suffixes.
 * Run: bun ./tests/stress.ts
 * It measures combat sweeps and cleanup, not rendering, audio, or Shallot physics.
 */
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
    advanceCombat, combatRandom, createCombat, fireProjectile, type CombatState,
} from "../src/combat";
import { createEnemy } from "../src/enemies";

const ENEMIES = 200;
const PROJECTILES = 500;
const WARMUP_TICKS = 120;
const MEASURED_TICKS = 600;
const FIXED_DT = 1 / 60;
const SEED = 20261020;
const player = { x: 0, z: 0 };

function refillProjectiles(state: CombatState): void {
    while (state.projectiles.length < PROJECTILES) {
        const angle = combatRandom(state) * Math.PI * 2;
        fireProjectile(state, player, { x: Math.cos(angle), z: Math.sin(angle) });
    }
}

function makeScenario(): CombatState {
    const state = createCombat(SEED, {
        enemyCap: ENEMIES, projectileCap: PROJECTILES,
        enemyHealth: 1e9, playerHealth: 1e9, contactDamage: 0,
    });
    for (let index = 0; index < ENEMIES; index++) {
        const angle = index / ENEMIES * Math.PI * 2;
        const radius = 6 + combatRandom(state) * 10;
        state.enemies.push(createEnemy(
            state.nextId++, { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius },
            0, state.tuning,
        ));
    }
    return state;
}

function checksum(state: CombatState): string {
    return Bun.hash(JSON.stringify({
        rng: state.randomState, health: state.health, score: state.score, time: state.time,
        enemies: state.enemies, projectiles: state.projectiles, effects: state.effects,
    })).toString(16);
}

function run(): { timings: number[]; state: CombatState } {
    const state = makeScenario();
    const timings: number[] = [];
    for (let tick = 0; tick < WARMUP_TICKS + MEASURED_TICKS; tick++) {
        refillProjectiles(state);
        if (state.enemies.length !== ENEMIES || state.projectiles.length !== PROJECTILES) {
            throw new Error("Stress target was not maintained");
        }
        const start = performance.now();
        advanceCombat(state, FIXED_DT, player);
        if (tick >= WARMUP_TICKS) timings.push(performance.now() - start);
    }
    return { timings, state };
}

const { timings, state } = run();
const replay = run();
const resultChecksum = checksum(state);
if (resultChecksum !== checksum(replay.state)) throw new Error("Deterministic stress replay diverged");
const sorted = [...timings].sort((a, b) => a - b);
const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]!;
const round = (value: number) => Math.round(value * 1000) / 1000;
console.log(JSON.stringify({
    recordedAt: new Date().toISOString(),
    machine: {
        platform: platform(), release: release(), architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length,
        memoryGiB: round(totalmem() / 1024 ** 3),
    },
    runtime: { name: "Bun", version: Bun.version },
    scenario: {
        seed: SEED, enemiesPerTick: ENEMIES, projectilesPerTick: PROJECTILES,
        warmupTicks: WARMUP_TICKS, measuredTicks: MEASURED_TICKS, fixedHz: 60,
        scope: "CPU combat only; refill excluded; no renderer, audio, or Shallot physics",
    },
    millisecondsPerTick: {
        mean: round(timings.reduce((sum, value) => sum + value, 0) / timings.length),
        p50: round(percentile(0.5)), p95: round(percentile(0.95)),
        p99: round(percentile(0.99)), max: round(sorted.at(-1)!),
    },
    outcome: {
        deterministicReplay: true, checksum: resultChecksum,
        enemies: state.enemies.length, survivingProjectiles: state.projectiles.length,
        effects: state.effects.length, effectCap: state.tuning.effectCap,
    },
}, null, 2));
