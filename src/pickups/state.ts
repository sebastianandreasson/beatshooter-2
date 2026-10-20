export const PICKUP_KINDS = ["health", "magnet", "bomb"] as const;
export type PickupKind = typeof PICKUP_KINDS[number];
export const HEALTH_PICKUP_AMOUNT = 50;
export const BOMB_DAMAGE = 100;
export const BOMB_DURATION = 0.75;
export const PICKUP_RADIUS = 0.7;

export interface Pickup {
    id: number;
    kind: PickupKind;
    x: number;
    z: number;
    spawnAt: number;
}
export interface BombWave {
    id: number;
    x: number;
    z: number;
    startedAt: number;
    maxRadius: number;
    previousRadius: number;
    radius: number;
    hitIds: Set<number>;
}
export interface PickupState {
    schedule: Pickup[];
    nextSpawn: number;
    drops: Pickup[];
    waves: BombWave[];
    position: number;
    collected: Record<PickupKind, number>;
    notice?: { kind: PickupKind; amount: number; at: number };
}

/** Independent RNG: pickups never consume weapon, upgrade or enemy randomness. */
export function createPickups(seed: number, duration = 0, arenaHalfExtent = 18): PickupState {
    if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(arenaHalfExtent) || arenaHalfExtent <= 0) {
        throw new RangeError("Pickups need a finite song duration and arena size.");
    }
    let randomState = (seed ^ 0xB04B50F1) >>> 0;
    const random = () => {
        randomState = (randomState + 0x6D2B79F5) >>> 0;
        let value = randomState;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const kinds: PickupKind[] = [...PICKUP_KINDS, PICKUP_KINDS[Math.floor(random() * 3)]!];
    for (let i = kinds.length - 1; i > 0; i--) {
        const other = Math.floor(random() * (i + 1));
        [kinds[i], kinds[other]] = [kinds[other]!, kinds[i]!];
    }
    // Four separated windows, with time left to reach even the final pickup.
    // Keep every pickup inside the walkable floor and away from the walls.
    const edge = arenaHalfExtent * 0.75;
    const schedule = duration > 0 ? kinds.map((kind, index) => ({
        id: index + 1, kind, spawnAt: duration * (0.12 + index * 0.2 + random() * 0.1),
        x: (random() * 2 - 1) * edge, z: (random() * 2 - 1) * edge,
    })) : [];
    return { schedule, nextSpawn: 0, drops: [], waves: [], position: 0,
        collected: { health: 0, magnet: 0, bomb: 0 } };
}

/** Raw song time owns spawning and bomb travel; held/backward clocks cannot replay them. */
export function advancePickups(state: PickupState, position: number): void {
    if (!Number.isFinite(position) || position < 0) return;
    state.position = Math.max(state.position, position);
    while (state.nextSpawn < state.schedule.length && state.schedule[state.nextSpawn]!.spawnAt <= state.position) {
        state.drops.push({ ...state.schedule[state.nextSpawn++]! });
    }
}

export function startBomb(state: PickupState, pickup: Pickup, arenaHalfExtent: number): void {
    state.waves.push({ id: pickup.id, x: pickup.x, z: pickup.z, startedAt: state.position,
        maxRadius: arenaHalfExtent * 2 * 0.25, radius: 0, previousRadius: 0, hitIds: new Set() });
}

/** Keep the final swept annulus for one combat step, even when an observation jumps. */
export function advanceBombWaves(state: PickupState): void {
    state.waves = state.waves.filter(wave => wave.radius < wave.maxRadius);
    for (const wave of state.waves) {
        wave.previousRadius = wave.radius;
        wave.radius = wave.maxRadius * Math.min(1, Math.max(0, (state.position - wave.startedAt) / BOMB_DURATION));
    }
}
