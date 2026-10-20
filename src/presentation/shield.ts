import { Transform, type Resource, type World } from "@dylanebert/shallot";
import { Arena, box } from "../arena";
import { shieldReady } from "../combat/specials";
import { MusicVisuals } from "../music-visuals";
import { PlayerState } from "../player";
import { isArenaPhase, Session, SessionEntity } from "../session";

const ShieldPresentation: Resource<{ generation: number; segments: number[] }> = {
    create: () => ({ generation: -1, segments: [] }),
};

/** A small musical outline shows an available charge; an absorbed hit breaks it away. */
export function presentShield(world: World): void {
    const s = world.resource(Session), state = world.resource(ShieldPresentation);
    if (state.generation !== s.generation) {
        // Session teardown owns these entities.
        state.segments = [];
        state.generation = s.generation;
    }
    const owned = s.combat.playerStats.effective.regenerativeShield > 0;
    const arena = world.resource(Arena), pose = world.storage(Transform);
    if (owned && state.segments.length === 0) {
        state.segments = Array.from({ length: 12 }, () => {
            const eid = box(world, arena.materials.rim, [0, 0, 0], [0, 0, 0]);
            world.add(eid, SessionEntity);
            return eid;
        });
    }
    const visuals = world.resource(MusicVisuals);
    const ready = shieldReady(s.combat, s.position);
    const breakAge = Math.max(0, s.position - s.combat.shieldLastBlockedAt);
    const breaking = owned && !ready && visuals.motionAllowed && breakAge < 0.25;
    const shown = owned && isArenaPhase(s.phase) && (ready || breaking);
    const pulse = visuals.motionAllowed ? visuals.frame.beatPulse : 0;
    const radius = 1.2 + pulse * 0.035 + (breaking ? breakAge * 2 : 0);
    const thickness = shown ? 0.035 * (breaking ? 1 - breakAge / 0.25 : 1) : 0;
    const ship = world.resource(PlayerState).ship;
    const x = pose.translation.x.get(ship), z = pose.translation.z.get(ship);
    for (let i = 0; i < state.segments.length; i++) {
        const eid = state.segments[i]!, angle = i * Math.PI / 6;
        pose.translation.set(eid, x + Math.cos(angle) * radius, 0.55, z + Math.sin(angle) * radius);
        pose.rotation.set(eid, 0, Math.sin(-angle / 2), 0, Math.cos(-angle / 2));
        pose.scale.set(eid, thickness, thickness, shown ? 0.48 : 0);
    }
}
