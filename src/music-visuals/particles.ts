import { Materials, Meshes, MeshInstance, MeshMaterial, StandardMaterial, Transform, type World } from "@dylanebert/shallot";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { burstAge, shardPose, type EffectDirector } from "./effects";
import { eventPriority } from "./events";

export interface ParticlePool {
    shards: number[]; rings: number[]; visible: Set<number>;
    mint: MaterialHandle; amber: MaterialHandle; ringMaterial: MaterialHandle; ringMesh: MeshHandle;
    azure: MaterialHandle; gold: MaterialHandle; levelRing: MaterialHandle; goldRing: MaterialHandle;
    activeShards: number; activeRings: number;
}

function ringGeometry() {
    const vertices: number[] = [], indices: number[] = [];
    for (let i = 0; i <= 48; i++) {
        const a = i / 48 * Math.PI * 2;
        for (const radius of [0.96, 1]) {
            vertices.push(Math.cos(a) * radius, 0, Math.sin(a) * radius, i / 48, 0, 1, 0, radius);
        }
        if (i < 48) {
            const k = i * 2;
            indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/** Fixed-capacity entities with shared geometry/materials, never physics bodies. */
export function createParticlePool(world: World): ParticlePool {
    const materials = world.resource(Materials);
    const material = (baseColor: [number, number, number, number]) =>
        materials.add(StandardMaterial({ baseColor, unlit: true }));
    const mint = material([0.2, 0.55, 0.44, 1]);
    const amber = material([0.6, 0.32, 0.13, 1]);
    const ringMaterial = material([0.065, 0.18, 0.16, 1]);
    const azure = material([0.18, 0.62, 0.9, 1]);
    const gold = material([0.85, 0.65, 0.24, 1]);
    const levelRing = material([0.08, 0.32, 0.47, 1]);
    const goldRing = material([0.35, 0.27, 0.1, 1]);
    const allocate = (count: number, handle: MaterialHandle) => Array.from({ length: count }, () => {
        const eid = world.create();
        world.add(eid, Transform, { scale: [0, 0, 0] });
        world.add(eid, MeshMaterial, handle);
        return eid;
    });
    return {
        shards: allocate(256, mint), rings: allocate(8, ringMaterial), visible: new Set(),
        mint, amber, ringMaterial, azure, gold, levelRing, goldRing,
        ringMesh: world.resource(Meshes).add({ name: "Beatshooter pulse ring", ...ringGeometry() }),
        activeShards: 0, activeRings: 0,
    };
}

export function clearParticlePool(world: World, pool: ParticlePool): void {
    for (const eid of pool.visible) if (world.has(eid, MeshInstance)) world.remove(eid, MeshInstance);
    pool.visible.clear();
    pool.activeShards = pool.activeRings = 0;
}

export function renderParticles(
    world: World, pool: ParticlePool, director: EffectDirector, position: number,
    highQuality: boolean, motion: boolean, intensity: number,
): void {
    const next = new Set<number>(), pose = world.storage(Transform);
    const cap = highQuality ? 256 : 64;
    let shards = 0, rings = 0;
    const bursts = [...director.bursts].sort((a, b) => eventPriority(b.kind) - eventPriority(a.kind));
    for (const burst of bursts) {
        const age = burstAge(director.timeline, burst, position);
        if (age < 0 || age >= 1 || intensity <= 0) continue;
        const fade = director.timeline.ageSince(burst.birth, position).strength;
        if (fade <= 0) continue;
        const levelUp = burst.kind === "level-up";
        const count = burst.kind === "spawn" || burst.kind === "player-hit" ? 0 :
            burst.quiet || !motion ? levelUp ? 6 : 3 :
            burst.kind === "shot" ? 3 : levelUp ? highQuality && intensity > 0.5 ? 24 : 12 : highQuality ? 16 : 8;
        for (let i = 0; i < count && shards < cap; i++) {
            const eid = pool.shards[shards++]!;
            const value = shardPose(burst, i, age, motion);
            if (!pool.visible.has(eid)) world.add(eid, MeshInstance);
            const material = levelUp ? i % 3 === 0 ? pool.gold : pool.azure
                : burst.critical ? pool.amber : pool.mint;
            world.storage(MeshMaterial).material.set(eid, material.material);
            pose.translation.set(eid, value.x, value.y, value.z);
            const scale = value.scale * (0.55 + intensity * 0.45) * fade;
            pose.scale.set(eid, scale, scale * (levelUp ? 1.6 : 0.45), scale * (levelUp ? 1 : burst.critical ? 2 : 1.5));
            if (levelUp) {
                // Tilt the narrow shards into small rising diamonds.
                const half = value.rotation / 2, tilt = Math.PI / 8;
                pose.rotation.set(eid, Math.sin(tilt) * Math.cos(half), Math.cos(tilt) * Math.sin(half),
                    -Math.sin(tilt) * Math.sin(half), Math.cos(tilt) * Math.cos(half));
            } else {
                pose.rotation.set(eid, 0, Math.sin(value.rotation / 2), 0, Math.cos(value.rotation / 2));
            }
            next.add(eid);
        }
        const ringCount = levelUp && motion && !burst.quiet && intensity > 0.5 ? 2
            : levelUp || burst.kind === "kill" || burst.kind === "spawn" || burst.kind === "player-hit" ? 1 : 0;
        for (let i = 0; i < ringCount && rings < pool.rings.length; i++) {
            const eid = pool.rings[rings++]!;
            if (!pool.visible.has(eid)) world.add(eid, MeshInstance, { mesh: pool.ringMesh });
            const material = levelUp ? i === 0 ? pool.levelRing : pool.goldRing : pool.ringMaterial;
            world.storage(MeshMaterial).material.set(eid, material.material);
            const radius = motion && !burst.quiet
                ? levelUp ? 0.55 + (1 - (1 - age) ** 2) * (i === 0 ? 1.6 : 1.15)
                    : 0.45 + age * (burst.critical ? 1.65 : 1.15)
                : 0.6 - age * 0.25;
            const shrink = Math.min(1, (1 - age) * 5) * fade;
            pose.translation.set(eid, burst.x, -0.12 + i * 0.015, burst.z);
            pose.scale.set(eid, radius * shrink, 1, radius * shrink);
            next.add(eid);
        }
    }
    for (const eid of pool.visible) if (!next.has(eid)) world.remove(eid, MeshInstance);
    pool.visible = next;
    pool.activeShards = shards; pool.activeRings = rings;
}
