import { MeshMaterial, Transform, type Plugin, type Resource, type World } from "@dylanebert/shallot";
import { worldToViewport } from "@dylanebert/shallot/rendering";
import { deriveTransforms } from "@dylanebert/shallot/transform";
import { Arena, box } from "../arena";
import { PlayerState, PresentPlayer, sampleAim } from "../player";
import { Session, SessionEntity } from "../session";
import { MusicVisuals, PresentMusicalVisuals } from "../music-visuals";
import { feedbackAge } from "../music-visuals/effects";

const Presentation: Resource<{
    generation: number; projectiles: Map<number, number>; effects: Map<number, HTMLElement>;
    layer?: HTMLElement; flashing: Set<number>; playerFlashing: boolean;
}> = { create: () => ({
    generation: -1, projectiles: new Map(), effects: new Map(), flashing: new Set(), playerFlashing: false,
}) };

function present(world: World): void {
    const s = world.resource(Session), p = world.resource(Presentation), arena = world.resource(Arena);
    const player = world.resource(PlayerState), pose = world.storage(Transform), visuals = world.resource(MusicVisuals);
    if (p.layer) p.layer.hidden = s.phase !== "playing";
    if (p.generation !== s.generation) {
        p.projectiles.clear();
        for (const element of p.effects.values()) element.remove();
        p.effects.clear();
        p.flashing.clear();
        p.playerFlashing = false;
        world.storage(MeshMaterial).material.set(player.ship, arena.materials.player.material);
        p.generation = s.generation;
    }
    deriveTransforms(world);
    sampleAim(world);
    for (const eid of arena.reticle) pose.translation.set(eid, player.target.x, 0.55, player.target.z);
    const live = new Set<number>();
    for (const shot of s.combat.projectiles) {
        live.add(shot.id);
        let eid = p.projectiles.get(shot.id);
        if (eid === undefined) {
            eid = box(world, arena.materials.shot, [shot.x, 0.55, shot.z], [0.14, 0.14, 0.65]);
            world.add(eid, SessionEntity);
            const yaw = Math.atan2(shot.velocityX, shot.velocityZ);
            pose.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
            p.projectiles.set(shot.id, eid);
        }
        const a = world.time.paused ? 1 : world.time.fixedAlpha;
        pose.translation.set(eid, shot.previousX + (shot.x - shot.previousX) * a, 0.55, shot.previousZ + (shot.z - shot.previousZ) * a);
    }
    for (const [id, eid] of p.projectiles) {
        if (!live.has(id)) { world.destroy(eid); p.projectiles.delete(id); }
    }
    const effects = new Set<number>();
    const bounds = typeof document === "undefined" ? undefined : document.querySelector("canvas")?.getBoundingClientRect();
    for (const effect of visuals.director.feedback) {
        effects.add(effect.id);
        let element = p.effects.get(effect.id);
        if (!element && p.layer) {
            element = document.createElement("span");
            element.className = `damage-number ${effect.critical ? "critical" : ""} ${effect.kind === "player-hit" ? "player-damage" : ""}`;
            element.textContent = effect.kind === "kill" ? "+100" : `${effect.critical ? "✦ " : ""}${effect.amount}`;
            p.layer.append(element);
            p.effects.set(effect.id, element);
        }
        const age = Math.max(0, feedbackAge(visuals.timeline, effect, s.visualPosition));
        const fade = visuals.timeline.ageSince(effect.birth, s.visualPosition).strength;
        const rise = visuals.motionAllowed ? age * 1.35 : 0;
        const pixel = worldToViewport(world, arena.camera, [effect.x, 1.5 + rise, effect.z]);
        if (element && pixel && bounds) {
            element.style.transform = `translate(${bounds.left + pixel[0]}px, ${bounds.top + pixel[1]}px) translate(-50%, -50%)`;
            element.style.opacity = String(Math.max(0, Math.min(1, (1 - age) * 3)) * fade);
        }
    }
    for (const [id, element] of p.effects) {
        if (!effects.has(id)) { element.remove(); p.effects.delete(id); }
    }
    // A steady local damage tint replaces the old free-running flashes.
    for (const enemy of s.combat.enemies) {
        const eid = s.enemyBodies.get(enemy.id);
        if (eid === undefined) continue;
        const flash = !s.preferences.settings.reducedFlash && visuals.intensity > 0 &&
            visuals.director.feedback.some(effect => effect.kind === "hit" &&
                Math.hypot(effect.x - enemy.x, effect.z - enemy.z) < 1 &&
                feedbackAge(visuals.timeline, effect, s.visualPosition) < 0.3);
        if (flash !== p.flashing.has(eid)) {
            world.storage(MeshMaterial).material.set(eid, (flash ? arena.materials.hit : arena.materials.enemy).material);
            if (flash) p.flashing.add(eid); else p.flashing.delete(eid);
        }
    }
    const playerFlash = s.combat.invulnerableUntil > s.combat.time;
    if (playerFlash !== p.playerFlashing) {
        world.storage(MeshMaterial).material.set(player.ship, (playerFlash ? arena.materials.hit : arena.materials.player).material);
        p.playerFlashing = playerFlash;
    }
}

export const PresentationPlugin: Plugin = {
    name: "Beatshooter/Presentation",
    initialize(world) {
        if (typeof document === "undefined") return;
        const state = world.resource(Presentation);
        state.layer = document.createElement("div");
        state.layer.className = "damage-layer";
        state.layer.setAttribute("aria-hidden", "true");
        document.body.append(state.layer);
        const style = document.createElement("style");
        style.textContent = ".damage-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0}.damage-number{position:absolute;left:0;top:0;font:700 16px ui-monospace,monospace;color:#e5fff5;text-shadow:0 2px 4px #000}.damage-number.critical{color:#ffe0a3;font-size:21px}.damage-number.player-damage{color:#ff817a}";
        document.head.append(style);
        world.onDispose(() => { state.layer?.remove(); style.remove(); });
    },
    systems: [{ name: "Beatshooter/Presentation", group: "simulation", after: [PresentPlayer, PresentMusicalVisuals], update: present }],
};
