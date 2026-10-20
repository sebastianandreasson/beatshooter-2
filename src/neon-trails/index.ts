import {
    Materials, Meshes, MeshInstance, MeshMaterial, MeshPlugin, StandardMaterial, Transform,
    type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { AlphaMode, type MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { PLAYER_COLLISION_GROUP, type Projectile } from "../combat";
import { MusicVisuals } from "../music-visuals";
import { PlayerState } from "../player";
import { Presentation, PresentationPlugin } from "../presentation";
import { isArenaPhase, Session } from "../session";
import type { TrackManifest } from "../tracks";
import { LOW_TRAIL_CAPACITY, sampleTrailPose, TRAIL_CAPACITY, trailGeometry, type TrailPose } from "./pose";

interface TrailBirth {
    position: number; lastBounceBeat: number; seen: number;
    headX: number; headZ: number;
}
export interface TrailWitness extends TrailPose {
    entity: number; projectileId: number; hostile: boolean; age: number; beatDuration: number;
}

export const NeonTrails: Resource<{
    capacity: number; visibleCount: number; motionAllowed: boolean;
    entities: number[]; witnesses: TrailWitness[];
    generation: number; track?: TrackManifest; lastPosition: number;
    mesh?: MeshHandle; playerMaterial?: MaterialHandle; hostileMaterial?: MaterialHandle;
    births: Map<number, TrailBirth>; candidates: Projectile[]; epoch: number; scratch: TrailPose;
}> = {
    create: () => ({
        capacity: TRAIL_CAPACITY, visibleCount: 0, motionAllowed: false,
        entities: [], witnesses: [], generation: -1, lastPosition: -Infinity,
        births: new Map(), candidates: [], epoch: 0,
        scratch: { x: 0, y: 0.55, z: 0, width: 0, length: 0, yaw: 0 },
    }),
};

/** Allocate once. Omitting the registered mesh uses Shallot's default box in CPU-only tests. */
export function createNeonTrailPool(world: World, mesh?: MeshHandle): void {
    const state = world.resource(NeonTrails), materials = world.resource(Materials);
    if (state.entities.length) return;
    state.mesh = mesh;
    const material = (baseColor: [number, number, number, number]) =>
        materials.add(StandardMaterial({ baseColor, unlit: true }), { alphaMode: AlphaMode.Blend });
    state.playerMaterial = material([1.05, 1.8, 1.55, 0.22]);
    state.hostileMaterial = material([1.8, 0.9, 0.8, 0.2]);
    for (let index = 0; index < state.capacity; index++) {
        const eid = world.create();
        world.add(eid, Transform, { scale: [0, 0, 0] });
        world.add(eid, MeshMaterial, state.playerMaterial);
        state.entities.push(eid);
    }
}

function hideFrom(world: World, start: number): void {
    const state = world.resource(NeonTrails), transform = world.storage(Transform);
    for (let index = start; index < state.visibleCount; index++) {
        const eid = state.entities[index]!;
        if (world.has(eid, MeshInstance)) world.remove(eid, MeshInstance);
        transform.scale.set(eid, 0, 0, 0);
    }
    state.visibleCount = start;
}

export const PresentNeonTrails: System = {
    name: "Beatshooter/PresentNeonTrails", group: "simulation",
    // Read the projectile heads after their existing interpolation, without moving them.
    after: [...(PresentationPlugin.systems ?? [])],
    update(world) {
        const session = world.resource(Session), state = world.resource(NeonTrails);
        const visuals = world.resource(MusicVisuals), settings = session.preferences.settings;
        const position = Number.isFinite(session.position) ? Math.max(0, session.position) : 0;
        const reset = state.generation !== session.generation || state.track !== session.track
            || position < state.lastPosition - 0.001;
        if (reset) {
            hideFrom(world, 0);
            state.births.clear();
            state.generation = session.generation;
            state.track = session.track;
        }
        state.motionAllowed = isArenaPhase(session.phase) && visuals.motionAllowed
            && settings.effectsIntensity !== "off" && !settings.reducedFlash && !visuals.osReducedMotion;
        state.witnesses.length = 0;
        state.candidates.length = 0;
        if (!state.motionAllowed || !state.playerMaterial || !state.hostileMaterial) {
            hideFrom(world, 0);
            state.births.clear();
            state.lastPosition = position;
            return;
        }
        const presentation = world.resource(Presentation), transform = world.storage(Transform);
        const player = world.resource(PlayerState).position;
        const hostile = (shot: Projectile) => (shot.collisionMask & PLAYER_COLLISION_GROUP) !== 0;
        for (const shot of session.combat.projectiles) {
            const eid = presentation.projectiles.get(shot.id);
            if (shot.waitingForBounce || Math.hypot(shot.velocityX, shot.velocityZ) < 0.0001
                || eid === undefined || !world.has(eid, Transform) || !world.has(eid, MeshInstance)) continue;
            state.candidates.push(shot);
        }
        state.candidates.sort((a, b) => Number(hostile(b)) - Number(hostile(a))
            || (a.x - player.x) ** 2 + (a.z - player.z) ** 2
                - (b.x - player.x) ** 2 - (b.z - player.z) ** 2
            || a.id - b.id);
        const limit = Math.min(state.entities.length, settings.graphics === "high" ? state.capacity : LOW_TRAIL_CAPACITY);
        const beatDuration = visuals.timeline.sample(position).beatDuration;
        const calm = settings.effectsIntensity === "calm";
        const held = !reset && position === state.lastPosition && (session.phase === "paused" || world.time.paused);
        state.epoch++;
        let visible = 0;
        for (let index = 0; index < Math.min(state.candidates.length, limit); index++) {
            const shot = state.candidates[index]!, isHostile = hostile(shot);
            const head = presentation.projectiles.get(shot.id)!;
            let birth = state.births.get(shot.id);
            if (!birth || birth.lastBounceBeat !== shot.lastBounceBeat) {
                // Remaining lifetime recovers pre-existing travel when a shot enters
                // the visible budget. Thereafter age is the absolute music clock.
                const lifetime = isHostile ? session.combat.tuning.enemyProjectileLifetime : session.combat.tuning.projectileLifetime;
                const elapsed = Math.max(0, lifetime - shot.remainingLifetime);
                birth = {
                    position: position - elapsed, lastBounceBeat: shot.lastBounceBeat, seen: state.epoch,
                    headX: transform.translation.x.get(head), headZ: transform.translation.z.get(head),
                };
                state.births.set(shot.id, birth);
            }
            if (!held) {
                birth.headX = transform.translation.x.get(head);
                birth.headZ = transform.translation.z.get(head);
            }
            birth.seen = state.epoch;
            const age = Math.max(0, position - birth.position);
            const pose = sampleTrailPose(birth.headX, birth.headZ, shot.velocityX, shot.velocityZ,
                age, beatDuration, isHostile, calm, state.scratch);
            if (pose.length < 0.025) continue;
            const eid = state.entities[visible++]!;
            if (!world.has(eid, MeshInstance)) {
                world.add(eid, MeshInstance, state.mesh === undefined ? undefined : { mesh: state.mesh });
            }
            world.storage(MeshMaterial).material.set(eid, (isHostile ? state.hostileMaterial : state.playerMaterial).material);
            transform.translation.set(eid, pose.x, pose.y, pose.z);
            transform.rotation.set(eid, 0, Math.sin(pose.yaw / 2), 0, Math.cos(pose.yaw / 2));
            transform.scale.set(eid, pose.width, pose.width * 0.65, pose.length);
            if (state.witnesses.length < 3) {
                state.witnesses.push({ ...pose, entity: eid, projectileId: shot.id, hostile: isHostile, age, beatDuration });
            }
        }
        hideFrom(world, visible);
        for (const [id, birth] of state.births) {
            if (birth.seen !== state.epoch) state.births.delete(id);
        }
        state.lastPosition = position;
    },
};

export const NeonTrailsPlugin: Plugin = {
    name: "Beatshooter/NeonTrails",
    dependencies: [MeshPlugin],
    initialize(world) {
        const mesh = world.resource(Meshes).add({ name: "Beatshooter/NeonTrail", ...trailGeometry() });
        createNeonTrailPool(world, mesh);
        const state = world.resource(NeonTrails);
        world.onDispose(() => {
            state.births.clear();
            state.candidates.length = state.witnesses.length = 0;
            state.visibleCount = 0;
        });
    },
    systems: [PresentNeonTrails],
};
