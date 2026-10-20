import {
    Body, Camera, CameraMode, DirectionalLight, GlobalAmbientLight, lookAtRotation,
    Materials, Meshes, MeshInstance, MeshMaterial, MeshPlugin, StandardMaterial, StandardRenderer,
    Transform, type Plugin, type Resource, type World,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import type { Enemy } from "../enemies";
import { createSubdividedBox, waveCullBounds } from "../shockwave/geometry";

export const ARENA_HALF = 18;
type ArenaMaterials = Record<
    "floor" | "line" | "rim" | "wall" | "player" | "enemy" | "spinner" | "ranger" |
    "shot" | "hostileShot" | "white" | "hit",
    MaterialHandle
>;
export const Arena: Resource<{
    camera: number; reticle: number[]; floor: number; floorVertexCount: number; lines: number[];
    materials: ArenaMaterials;
}> = {
    create: () => ({
        camera: -1, reticle: [], floor: -1, floorVertexCount: 0, lines: [],
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
    dependencies: [MeshPlugin],
    initialize(world) {
        const arena = world.resource(Arena);
        const materials = world.resource(Materials);
        const material = (color: [number, number, number, number], unlit = false) =>
            materials.add(StandardMaterial({ baseColor: color, perceptualRoughness: 0.8, unlit }));
        const neon = (color: [number, number, number]) => materials.add(StandardMaterial({
            baseColor: [color[0] * 0.14, color[1] * 0.14, color[2] * 0.14, 1],
            emissive: color.map(channel => channel * 2.6) as [number, number, number],
            perceptualRoughness: 0.65,
        }));
        arena.materials = {
            floor: material([0.006, 0.012, 0.018, 1]),
            line: material([0.03, 0.09, 0.105, 1], true),
            rim: material([0.13, 1.15, 1, 1], true),
            wall: material([0.07, 0.19, 0.21, 1]),
            player: neon([0.12, 0.95, 0.75]),
            enemy: neon([0.95, 0.16, 0.12]),
            spinner: neon([0.58, 0.32, 0.95]),
            ranger: neon([0.95, 0.64, 0.15]),
            shot: material([0.7, 2.4, 1.7, 1], true),
            hostileShot: material([2.4, 0.3, 0.55, 1], true),
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
        const meshes = world.resource(Meshes), meshInstances = world.storage(MeshInstance);
        const mesh = (name: string, size: [number, number, number]) => {
            const { vertices, indices } = createSubdividedBox(size);
            return meshes.add({ name: `Beatshooter/${name}`, vertices, indices });
        };
        const floorGeometry = createSubdividedBox([37, 0.5, 37]);
        arena.floorVertexCount = floorGeometry.vertices.length / 8;
        const floorMesh = meshes.add({
            name: "Beatshooter/WaveFloor", vertices: floorGeometry.vertices, indices: floorGeometry.indices,
        });
        const wallZMesh = mesh("WaveWallZ", [1, 0.8, 38]);
        const wallXMesh = mesh("WaveWallX", [38, 0.8, 1]);
        const lineZMesh = mesh("WaveGridZ", [0.035, 0.025, 36]);
        const lineXMesh = mesh("WaveGridX", [36, 0.025, 0.035]);
        const denseBox = (
            material: MaterialHandle, position: [number, number, number], size: [number, number, number],
            handle: ReturnType<typeof mesh>,
        ) => {
            const eid = box(world, material, position, size);
            meshInstances.mesh.set(eid, handle);
            meshInstances.cullBounds.set(eid, ...waveCullBounds(size));
            return eid;
        };
        arena.floor = denseBox(arena.materials.floor, [0, -0.4, 0], [37, 0.5, 37], floorMesh);
        for (let i = -18; i <= 18; i += 3) {
            arena.lines.push(denseBox(arena.materials.line, [i, -0.135, 0], [0.035, 0.025, 36], lineZMesh));
            arena.lines.push(denseBox(arena.materials.line, [0, -0.135, i], [36, 0.025, 0.035], lineXMesh));
        }
        for (const [x, z, sx, sz] of [[-18.5, 0, 1, 38], [18.5, 0, 1, 38], [0, -18.5, 38, 1], [0, 18.5, 38, 1]]) {
            const wallMesh = sx! > sz! ? wallXMesh : wallZMesh;
            const wall = denseBox(arena.materials.wall, [x!, 0.2, z!], [sx!, 0.8, sz!], wallMesh);
            world.add(wall, Body);
            world.add(wall, Shape, { filterCategoryLow: 4, filterMaskLow: 3, filterCategoryHigh: 0, filterMaskHigh: 0, friction: 0 });
            const horizontal = sx! > sz!;
            denseBox(arena.materials.rim,
                [horizontal ? x! : Math.sign(x!) * 18.04, 0.62, horizontal ? Math.sign(z!) * 18.04 : z!],
                [horizontal ? sx! : 0.055, 0.035, horizontal ? 0.055 : sz!], wallMesh);
        }
        for (const [sx, sz] of [[0.65, 0.045], [0.045, 0.65]]) {
            arena.reticle.push(box(world, arena.materials.white, [0, 0.65, -4], [sx!, 0.04, sz!]));
        }
    },
};
