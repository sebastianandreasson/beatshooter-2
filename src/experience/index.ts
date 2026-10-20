import {
    Materials, Meshes, MeshInstance, MeshMaterial, MeshPlugin, StandardMaterial, Transform,
    type Plugin, type Resource, type System,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { MusicVisuals, PresentMusicalVisuals } from "../music-visuals";
import { isArenaPhase, Session, SessionEntity } from "../session";

export const ExperiencePresentation: Resource<{
    generation: number; drops: Map<number, number>;
    mesh?: MeshHandle; material?: MaterialHandle;
}> = { create: () => ({ generation: -1, drops: new Map() }) };

function gemGeometry() {
    const vertices: number[] = [], indices: number[] = [];
    const equator = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
    for (let face = 0; face < 4; face++) {
        const current = equator[face]!, next = equator[(face + 1) % 4]!;
        for (const triangle of [[[0, 1, 0], next, current], [[0, -1, 0], current, next]]) {
            const [a, b, c] = triangle as [number[], number[], number[]];
            const ab = b.map((value, axis) => value - a[axis]!);
            const ac = c.map((value, axis) => value - a[axis]!);
            const normal = [
                ab[1]! * ac[2]! - ab[2]! * ac[1]!,
                ab[2]! * ac[0]! - ab[0]! * ac[2]!,
                ab[0]! * ac[1]! - ab[1]! * ac[0]!,
            ];
            const length = Math.hypot(...normal);
            for (const point of triangle) {
                indices.push(indices.length);
                vertices.push(...point, 0, ...normal.map(value => value / length), 0);
            }
        }
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export const PresentExperience: System = {
    name: "Beatshooter/PresentExperience", group: "simulation", after: [PresentMusicalVisuals],
    update(world) {
        const session = world.resource(Session), state = world.resource(ExperiencePresentation);
        const visuals = world.resource(MusicVisuals), pose = world.storage(Transform);
        if (state.generation !== session.generation) {
            // Session teardown owns all prior entities, including uncollected gems.
            state.drops.clear();
            state.generation = session.generation;
        }
        if (state.mesh === undefined || state.material === undefined) return;
        const visible = isArenaPhase(session.phase);
        const live = new Set<number>();
        const alpha = world.time.paused ? 1 : world.time.fixedAlpha;
        const motion = visuals.motionAllowed && visuals.frame.active;
        const pulse = motion ? visuals.frame.beatPulse * visuals.intensity : 0;
        const yaw = Math.PI / 4 + (motion ? visuals.frame.barCoordinate * Math.PI / 2 : 0);
        for (const drop of visible ? session.combat.experience.drops : []) {
            live.add(drop.id);
            let eid = state.drops.get(drop.id);
            if (eid === undefined) {
                eid = world.create();
                world.add(eid, SessionEntity);
                world.add(eid, Transform);
                world.add(eid, MeshInstance, { mesh: state.mesh });
                world.add(eid, MeshMaterial, state.material);
                state.drops.set(drop.id, eid);
            }
            // Essential pickup visibility is independent of decoration settings.
            // Only idle flourish follows the musical clock; attraction follows
            // the authoritative fixed-step pickup simulation.
            const size = Math.min(0.31, 0.21 + Math.log2(Math.max(1, drop.value)) * 0.012);
            const scale = size * (1 + pulse * 0.06);
            pose.translation.set(eid,
                drop.previousX + (drop.x - drop.previousX) * alpha,
                0.4 + pulse * 0.035,
                drop.previousZ + (drop.z - drop.previousZ) * alpha);
            pose.scale.set(eid, scale, scale * 1.45, scale);
            pose.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        }
        for (const [id, eid] of state.drops) {
            if (!live.has(id)) { world.destroy(eid); state.drops.delete(id); }
        }
    },
};

export const ExperiencePlugin: Plugin = {
    name: "Beatshooter/Experience",
    dependencies: [MeshPlugin],
    initialize(world) {
        const state = world.resource(ExperiencePresentation);
        state.mesh = world.resource(Meshes).add({ name: "Beatshooter experience gem", ...gemGeometry() });
        state.material = world.resource(Materials).add(StandardMaterial({
            baseColor: [0.045, 0.58, 1, 1], emissive: [0.005, 0.035, 0.075],
            perceptualRoughness: 0.3, metallic: 0.1,
        }));
    },
    systems: [PresentExperience],
};
