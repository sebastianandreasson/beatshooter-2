import {
    Materials, Meshes, MeshInstance, MeshMaterial, StandardMaterial, Transform,
    type Resource, type World,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { MusicVisuals } from "../music-visuals";
import { createPlayerShipGeometry } from "../player/ship-geometry";
import { isArenaPhase, Session, SessionEntity } from "../session";
import { EXPLOSION_VISUAL_SECONDS } from "../combat/upgrade-effects";
import { ringGeometry } from "./ring-geometry";

export const UpgradeEffectPresentation: Resource<{
    generation: number;
    cloneId?: number;
    clone: number[];
    explosions: Map<number, number>;
    meshes?: { ship: MeshHandle[]; ring: MeshHandle };
    colors?: { hull: MaterialHandle; edge: MaterialHandle; explosion: MaterialHandle };
}> = { create: () => ({ generation: -1, clone: [], explosions: new Map() }) };

/** Cache geometry/materials for the world; only transient entities follow a song. */
export function presentUpgradeEffects(world: World): void {
    const session = world.resource(Session), state = world.resource(UpgradeEffectPresentation);
    if (state.generation !== session.generation) {
        state.clone = []; state.cloneId = undefined; state.explosions.clear();
        state.generation = session.generation;
    }
    const visible = isArenaPhase(session.phase);
    const clone = visible ? session.combat.afterImage : undefined;
    const blasts = visible ? session.combat.explosions : [];
    if (!state.meshes && (clone || blasts.length)) {
        const meshes = world.resource(Meshes), materials = world.resource(Materials);
        const geometry = createPlayerShipGeometry();
        state.meshes = {
            ship: [geometry.hull, ...geometry.wings, geometry.cockpit, geometry.edges].map((data, i) =>
                meshes.add({ name: `After Image/${i}`, ...data })),
            ring: meshes.add({ name: "Enemy explosion ring", ...ringGeometry() }),
        };
        const color = (rgb: [number, number, number]) => materials.add(StandardMaterial({
            baseColor: [...rgb, 1], unlit: true,
        }));
        state.colors = { hull: color([0.12, 0.19, 0.38]), edge: color([0.55, 0.75, 1.1]), explosion: color([1, 0.55, 0.16]) };
    }
    if (!state.meshes || !state.colors) return;
    const pose = world.storage(Transform), visuals = world.resource(MusicVisuals);
    const create = (mesh: MeshHandle, material: MaterialHandle) => {
        const eid = world.create();
        world.add(eid, Transform);
        world.add(eid, MeshInstance, { mesh });
        world.add(eid, MeshMaterial, material);
        world.add(eid, SessionEntity);
        return eid;
    };
    if (clone?.id !== state.cloneId) {
        state.clone.forEach(eid => world.destroy(eid));
        state.clone = clone ? state.meshes.ship.map((mesh, i) =>
            create(mesh, i >= state.meshes!.ship.length - 2 ? state.colors!.edge : state.colors!.hull)) : [];
        state.cloneId = clone?.id;
    }
    if (clone) {
        const yaw = Math.atan2(-clone.aim.x, -clone.aim.z);
        for (const eid of state.clone) {
            pose.translation.set(eid, clone.x, 0.55, clone.z);
            pose.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
            pose.scale.set(eid, 1, 1, 1);
        }
    }
    const live = new Set<number>();
    for (const blast of blasts) {
        live.add(blast.id);
        let eid = state.explosions.get(blast.id);
        if (eid === undefined) {
            eid = create(state.meshes.ring, state.colors.explosion);
            state.explosions.set(blast.id, eid);
        }
        const age = Math.max(0, session.combat.time - blast.bornAt);
        // Off/reduced-motion still shows the exact damaged area, without a pulse.
        const scale = visuals.motionAllowed ? Math.min(1, 0.4 + age / (EXPLOSION_VISUAL_SECONDS * 0.35)) : 1;
        pose.translation.set(eid, blast.x, 0.16, blast.z);
        pose.scale.set(eid, blast.radius * scale, 1, blast.radius * scale);
    }
    for (const [id, eid] of state.explosions) {
        if (!live.has(id)) { world.destroy(eid); state.explosions.delete(id); }
    }
}
