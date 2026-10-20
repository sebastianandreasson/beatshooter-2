import {
    Materials, Meshes, MeshInstance, MeshMaterial, StandardMaterial, Transform, type World,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { createPlayerShipGeometry, SHIP_ENGINE_OFFSETS, type ShipMeshData } from "./ship-geometry";

export interface PlayerShipThruster {
    nozzle: number;
    plume: number;
    core: number;
    offset: [number, number, number];
}

export interface PlayerShip {
    hull: number;
    cockpit: number;
    wings: number[];
    /** Static meshes share the hull's origin and aim rotation; exhaust is separate. */
    parts: readonly number[];
    hullMaterial: MaterialHandle;
    thrusters: readonly PlayerShipThruster[];
    engineMaterials: Record<"idle" | "ready" | "used" | "boost", MaterialHandle>;
}

/** Allocate the small cosmetic assembly once; the caller owns all presentation. */
export function createPlayerShip(world: World): PlayerShip {
    const materials = world.resource(Materials), meshes = world.resource(Meshes);
    const geometry = createPlayerShipGeometry();
    const hullMaterial = materials.add(StandardMaterial({
        baseColor: [0.69, 0.8, 0.9, 1], metallic: 0.18, perceptualRoughness: 0.48,
    }));
    const wingMaterial = materials.add(StandardMaterial({
        baseColor: [0.025, 0.16, 0.5, 1], emissive: [0.015, 0.055, 0.17],
        metallic: 0.2, perceptualRoughness: 0.5,
    }));
    const cockpitMaterial = materials.add(StandardMaterial({
        baseColor: [0.015, 0.11, 0.23, 1], emissive: [0.015, 0.28, 0.48],
        metallic: 0.3, perceptualRoughness: 0.3,
    }));
    const light = (color: [number, number, number]) =>
        materials.add(StandardMaterial({ baseColor: [...color, 1], unlit: true }));
    const edgeMaterial = light([0.12, 1.45, 1.8]);
    // Engine accents stay below bloom's soft knee; readiness is a quiet color cue.
    const engineMaterials: PlayerShip["engineMaterials"] = {
        idle: light([0.025, 0.075, 0.1]),
        ready: light([0.42, 0.23, 0.065]),
        used: light([0.015, 0.035, 0.05]),
        boost: light([0.16, 0.32, 0.4]),
    };
    const mesh = (name: string, data: ShipMeshData) =>
        meshes.add({ name: `Beatshooter/PlayerShip/${name}`, ...data });
    const part = (handle: MeshHandle, material: MaterialHandle, hidden = false) => {
        const entity = world.create();
        world.add(entity, Transform, { translation: [0, 0.55, 0], scale: hidden ? [0, 0, 0] : [1, 1, 1] });
        world.add(entity, MeshInstance, { mesh: handle });
        world.add(entity, MeshMaterial, material);
        return entity;
    };
    const hull = part(mesh("Hull", geometry.hull), hullMaterial);
    const cockpit = part(mesh("Cockpit", geometry.cockpit), cockpitMaterial);
    const wings = geometry.wings.map((data, index) => part(mesh(`Wing${index}`, data), wingMaterial));
    const edges = part(mesh("Edges", geometry.edges), edgeMaterial);
    const exhaust = mesh("Exhaust", geometry.exhaust);
    const thrusters = geometry.nozzles.map((data, index): PlayerShipThruster => ({
        nozzle: part(mesh(`Nozzle${index}`, data), engineMaterials.idle),
        plume: part(exhaust, engineMaterials.idle, true),
        core: part(exhaust, engineMaterials.boost, true),
        offset: [...SHIP_ENGINE_OFFSETS[index]!],
    }));
    return {
        hull, cockpit, wings, parts: [hull, cockpit, ...wings, edges, ...thrusters.map(thruster => thruster.nozzle)],
        hullMaterial, thrusters, engineMaterials,
    };
}
