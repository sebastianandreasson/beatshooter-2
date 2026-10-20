import { MeshMaterial, Transform, type World } from "@dylanebert/shallot";
import { DashState } from "../dash/state";
import { MusicVisuals } from "../music-visuals";
import { PlayerState } from "../player";
import { sampleShipEngine } from "../player/engine";
import { Session } from "../session";

/** Place a bounded exhaust pair on the interpolated hull, without moving its body. */
export function presentPlayerEngines(world: World): void {
    const player = world.resource(PlayerState), ship = player.visual;
    if (!ship) return;
    const session = world.resource(Session), dash = world.resource(DashState).controller;
    const visuals = world.resource(MusicVisuals), position = session.position;
    const live = session.phase === "playing" && player.enabled
        && session.transport?.state === "playing" && session.transport.context.state === "running";
    const frame = player.engine = sampleShipEngine({
        status: dash.status(position), position,
        available: (live || session.phase === "paused") && position >= 0
            && position < session.track.duration && session.combat.health > 0
            && !session.completePending && session.combat.playerStats.effective.dashDistance > 0,
        active: dash.active,
        motionAllowed: visuals.motionAllowed,
        calm: session.preferences.settings.effectsIntensity === "calm",
    });
    const pose = world.storage(Transform), materials = world.storage(MeshMaterial);
    const x = pose.translation.x.get(ship.hull), y = pose.translation.y.get(ship.hull), z = pose.translation.z.get(ship.hull);
    const qy = pose.rotation.y.get(ship.hull), qw = pose.rotation.w.get(ship.hull);
    const sin = 2 * qy * qw, cos = 1 - 2 * qy * qy;
    const material = ship.engineMaterials[frame.material];
    const coreMaterial = ship.engineMaterials[frame.status === "ready" || frame.status === "dashing" ? "boost" : frame.material];
    for (const thruster of ship.thrusters) {
        const [ox, oy, oz] = thruster.offset;
        for (const eid of [thruster.plume, thruster.core]) {
            pose.translation.set(eid, x + cos * ox + sin * oz, y + oy, z - sin * ox + cos * oz);
            pose.rotation.set(eid, 0, qy, 0, qw);
        }
        materials.material.set(thruster.nozzle, material.material);
        materials.material.set(thruster.plume, material.material);
        materials.material.set(thruster.core, coreMaterial.material);
        pose.scale.set(thruster.plume, frame.plumeWidth, frame.plumeWidth * 0.7, frame.plumeLength);
        pose.scale.set(thruster.core, frame.coreWidth, frame.coreWidth * 0.7, frame.coreLength);
    }
}
