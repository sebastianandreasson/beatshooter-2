import {
    Body, Camera, CameraMode, DirectionalLight, GlobalAmbientLight, lookAtRotation,
    Materials, MeshInstance, MeshMaterial, StandardMaterial, StandardRenderer,
    Transform, type Plugin, type Resource, type World,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import type { Enemy } from "../enemies";

export const ARENA_HALF = 18;
type ArenaMaterials = Record<
    "floor" | "line" | "wall" | "player" | "enemy" | "spinner" | "ranger" |
    "shot" | "hostileShot" | "white" | "hit",
    MaterialHandle
>;
export const Arena: Resource<{
    camera: number; reticle: number[]; floor: number; lines: number[];
    materials: ArenaMaterials;
}> = {
    create: () => ({
        camera: -1, reticle: [], floor: -1, lines: [],
        materials: {} as ArenaMaterials,
    }),
};

/** Damage tints must restore each archetype's normal appearance. */
export function enemyMaterial(arena: { materials: ArenaMaterials }, kind: Enemy["kind"]): MaterialHandle {
    return kind === "spinner" ? arena.materials.spinner
        : kind === "ranger" ? arena.materials.ranger : arena.materials.enemy;
}

export function box(world: World, material: MaterialHandle, position: [number, number, number], scale: [number, number, number]): number {
    const eid = world.create();
    world.add(eid, Transform, { translation: position, scale });
    world.add(eid, MeshInstance);
    world.add(eid, MeshMaterial, material);
    return eid;
}

export const ArenaPlugin: Plugin = {
    name: "Beatshooter/Arena",
    initialize(world) {
        const arena = world.resource(Arena);
        const materials = world.resource(Materials);
        const material = (color: [number, number, number, number], unlit = false) =>
            materials.add(StandardMaterial({ baseColor: color, perceptualRoughness: 0.8, unlit }));
        arena.materials = {
            floor: material([0.006, 0.012, 0.018, 1]),
            line: material([0.03, 0.09, 0.105, 1], true),
            wall: material([0.07, 0.19, 0.21, 1]),
            player: material([0.12, 0.95, 0.75, 1]),
            enemy: material([0.95, 0.16, 0.12, 1]),
            spinner: material([0.58, 0.32, 0.95, 1]),
            ranger: material([0.95, 0.64, 0.15, 1]),
            shot: material([0.55, 1, 0.85, 1], true),
            hostileShot: material([1, 0.3, 0.4, 1], true),
            white: material([0.9, 1, 0.96, 1], true),
            hit: material([1, 0.56, 0.15, 1], true),
        };
        const ambient = world.resource(GlobalAmbientLight);
        ambient.color = 0xc2e9ff;
        ambient.brightness = 400;
        const light = world.create();
        world.add(light, Transform, { rotation: lookAtRotation(0, 0, 0, -1, -3, -1) });
        world.add(light, DirectionalLight, { color: 0xffffff, illuminance: 4200 });
        arena.camera = world.create();
        world.add(arena.camera, Camera, { mode: CameraMode.Orthographic, size: 17, clearColor: 0x090f15, far: 160 });
        world.add(arena.camera, StandardRenderer);
        world.add(arena.camera, Transform, {
            translation: [0, 32, 19], rotation: lookAtRotation(0, 32, 19, 0, 0, 0),
        });
        arena.floor = box(world, arena.materials.floor, [0, -0.4, 0], [37, 0.5, 37]);
        for (let i = -18; i <= 18; i += 3) {
            arena.lines.push(box(world, arena.materials.line, [i, -0.135, 0], [0.035, 0.025, 36]));
            arena.lines.push(box(world, arena.materials.line, [0, -0.135, i], [36, 0.025, 0.035]));
        }
        for (const [x, z, sx, sz] of [[-18.5, 0, 1, 38], [18.5, 0, 1, 38], [0, -18.5, 38, 1], [0, 18.5, 38, 1]]) {
            const wall = box(world, arena.materials.wall, [x!, 0.2, z!], [sx!, 0.8, sz!]);
            world.add(wall, Body);
            world.add(wall, Shape, { filterCategoryLow: 4, filterMaskLow: 3, filterCategoryHigh: 0, filterMaskHigh: 0, friction: 0 });
            box(world, arena.materials.line, [x!, 0.62, z!], [sx!, 0.035, sz!]);
        }
        for (const [sx, sz] of [[0.65, 0.045], [0.045, 0.65]]) {
            arena.reticle.push(box(world, arena.materials.white, [0, 0.65, -4], [sx!, 0.04, sz!]));
        }
    },
};
