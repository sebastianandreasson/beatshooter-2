import {
    Materials, StandardMaterial, Transform,
    type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import { AlphaMode, type MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { Arena, box, enemyMaterial } from "../arena";
import type { Enemy } from "../enemies";
import { MusicVisuals, PresentMusicalVisuals } from "../music-visuals";
import { isArenaPhase, Session, SessionEntity } from "../session";
import { enemySpawnPose } from "./pose";

export interface SpawnEntities {
    body: number;
    accents: number[];
    beams: number[];
    outline: number[];
}

/** Cosmetic ownership only: none of these entities receives Body or Shape. */
export const EnemySpawnPresentation: Resource<{
    generation: number;
    spawns: Map<number, SpawnEntities>;
    materials?: Record<Enemy["kind"], MaterialHandle>;
    beamMaterials?: Record<Enemy["kind"], MaterialHandle>;
}> = { create: () => ({ generation: -1, spawns: new Map() }) };

function entities(spawn: SpawnEntities): number[] {
    return [spawn.body, ...spawn.accents, ...spawn.beams, ...spawn.outline];
}

function createSpawn(
    world: World, enemy: Enemy, indicatorMaterial: MaterialHandle, beamMaterial: MaterialHandle,
): SpawnEntities {
    const bodyMaterial = enemyMaterial(world.resource(Arena), enemy.kind);
    const create = (material: MaterialHandle) => {
        const eid = box(world, material, [enemy.x, 0.55, enemy.z], [0, 0, 0]);
        world.add(eid, SessionEntity);
        return eid;
    };
    return {
        body: create(bodyMaterial),
        accents: enemy.kind === "chaser" ? [] : Array.from({ length: 3 }, () => create(bodyMaterial)),
        beams: [...Array.from({ length: 4 }, () => create(indicatorMaterial)), create(beamMaterial)],
        outline: Array.from({ length: 4 }, () => create(indicatorMaterial)),
    };
}

export const PresentEnemySpawns: System = {
    name: "Beatshooter/PresentEnemySpawns", group: "simulation", after: [PresentMusicalVisuals],
    update(world) {
        const session = world.resource(Session), state = world.resource(EnemySpawnPresentation);
        const visuals = world.resource(MusicVisuals), transform = world.storage(Transform);
        if (state.generation !== session.generation) {
            // clearSession has already destroyed every previous SessionEntity.
            state.spawns.clear();
            state.generation = session.generation;
        }
        if (!state.materials || !state.beamMaterials) return;
        const live = new Set<number>();
        for (const pending of isArenaPhase(session.phase) ? session.combat.pendingSpawns : []) {
            const { enemy } = pending;
            live.add(enemy.id);
            let spawn = state.spawns.get(enemy.id);
            if (!spawn) {
                spawn = createSpawn(world, enemy, state.materials[enemy.kind], state.beamMaterials[enemy.kind]);
                state.spawns.set(enemy.id, spawn);
            }
            const value = enemySpawnPose(pending.startTime, pending.endTime, session.position, visuals);
            const yaw = value.yaw;
            const setYaw = (eid: number, angle: number) =>
                transform.rotation.set(eid, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2));
            transform.translation.set(spawn.body, enemy.x, value.y, enemy.z);
            transform.scale.set(spawn.body, value.scale, value.scale, value.scale);
            setYaw(spawn.body, yaw);
            // Match the final archetype silhouette so activation has no visual pop.
            for (let i = 0; i < spawn.accents.length; i++) {
                const eid = spawn.accents[i]!;
                const angle = enemy.heading + yaw - Math.PI / 4 + (enemy.kind === "spinner"
                    ? i * Math.PI * 2 / 3 : i === 0 ? 0 : (i === 1 ? -1 : 1) * Math.PI * 0.75);
                const offset = (enemy.kind === "spinner" || i === 0 ? 0.43 : 0.52) * value.scale;
                const scale = enemy.kind === "spinner" ? [0.2, 0.16, 0.85]
                    : i === 0 ? [0.19, 0.17, 0.85] : [0.18, 0.15, 0.5];
                transform.translation.set(eid, enemy.x + Math.sin(angle) * offset,
                    value.y + 0.57 * value.scale, enemy.z + Math.cos(angle) * offset);
                transform.scale.set(eid, scale[0]! * value.scale, scale[1]! * value.scale, scale[2]! * value.scale);
                setYaw(eid, angle);
            }
            const beamHeight = value.beamTop - value.beamBottom;
            const core = spawn.beams[4]!;
            transform.translation.set(core, enemy.x, (value.beamTop + value.beamBottom) / 2, enemy.z);
            transform.scale.set(core, value.beamCoreWidth, beamHeight, value.beamCoreWidth);
            setYaw(core, Math.PI / 4);
            for (let i = 0; i < 4; i++) {
                const angle = Math.PI / 4 + i * Math.PI / 2;
                const corner = i * Math.PI / 2;
                const beam = spawn.beams[i]!;
                transform.translation.set(beam,
                    enemy.x + Math.sin(corner) * value.outlineRadius,
                    (value.beamTop + value.beamBottom) / 2,
                    enemy.z + Math.cos(corner) * value.outlineRadius);
                transform.scale.set(beam, value.beamWidth, beamHeight, value.beamWidth);
                const edge = spawn.outline[i]!;
                transform.translation.set(edge,
                    enemy.x + Math.sin(angle) * value.outlineRadius / Math.SQRT2,
                    -0.1,
                    enemy.z + Math.cos(angle) * value.outlineRadius / Math.SQRT2);
                transform.scale.set(edge, value.outlineRadius * Math.SQRT2, 0.025, value.outlineWidth);
                setYaw(edge, angle);
            }
        }
        // Activation, results and menu transitions remove the whole preview.
        for (const [id, spawn] of state.spawns) {
            if (!live.has(id)) {
                for (const eid of entities(spawn)) world.destroy(eid);
                state.spawns.delete(id);
            }
        }
    },
};

export const EnemySpawnPlugin: Plugin = {
    name: "Beatshooter/EnemySpawn",
    initialize(world) {
        const materials = world.resource(Materials);
        const material = (baseColor: [number, number, number, number]) =>
            materials.add(StandardMaterial({ baseColor, unlit: true }));
        const state = world.resource(EnemySpawnPresentation);
        // Opaque rails define the arrival footprint; one faint blended core
        // makes it read as light without hiding the growing enemy inside.
        state.materials = {
            chaser: material([1.35, 0.25, 0.15, 1]),
            spinner: material([0.7, 0.35, 1.5, 1]),
            ranger: material([1.5, 0.9, 0.18, 1]),
        };
        const beam = (baseColor: [number, number, number, number]) =>
            materials.add(StandardMaterial({ baseColor, unlit: true }), { alphaMode: AlphaMode.Blend });
        state.beamMaterials = {
            chaser: beam([0.48, 0.24, 0.18, 0.075]),
            spinner: beam([0.34, 0.26, 0.55, 0.075]),
            ranger: beam([0.48, 0.39, 0.18, 0.075]),
        };
    },
    systems: [PresentEnemySpawns],
};
