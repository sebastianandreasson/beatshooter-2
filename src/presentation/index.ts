import { MeshMaterial, Transform, type Plugin, type Resource, type World } from "@dylanebert/shallot";
import { worldToViewport } from "@dylanebert/shallot/rendering";
import { deriveTransforms } from "@dylanebert/shallot/transform";
import { Arena, box, enemyMaterial } from "../arena";
import { PLAYER_COLLISION_GROUP } from "../combat";
import { PlayerState, PresentPlayer, sampleAim } from "../player";
import { isArenaPhase, Session, SessionEntity } from "../session";
import { MusicVisuals, PresentMusicalVisuals } from "../music-visuals";
import { damageNumberPose, feedbackAge } from "../music-visuals/effects";
import { SectionEffects } from "../section-effects/runtime";
import { shockwaveHeight } from "../shockwave/surface";

export const Presentation: Resource<{
    generation: number; projectiles: Map<number, number>; effects: Map<number, HTMLElement>;
    enemyAccents: Map<number, number[]>; healthbars: Map<number, HTMLElement>;
    layer?: HTMLElement; flashing: Set<number>; playerFlashing: boolean;
}> = { create: () => ({
    generation: -1, projectiles: new Map(), effects: new Map(), enemyAccents: new Map(),
    healthbars: new Map(), flashing: new Set(), playerFlashing: false,
}) };

function present(world: World): void {
    const s = world.resource(Session), p = world.resource(Presentation), arena = world.resource(Arena);
    const player = world.resource(PlayerState), pose = world.storage(Transform), visuals = world.resource(MusicVisuals);
    const section = world.resource(SectionEffects);
    const surfaceLift = (x: number, z: number) => shockwaveHeight(section.frame.waveProgress, section.strength, x, z);
    if (p.layer) p.layer.hidden = !isArenaPhase(s.phase) || s.phase === "paused";
    if (p.generation !== s.generation) {
        p.projectiles.clear();
        p.enemyAccents.clear();
        for (const element of p.effects.values()) element.remove();
        p.effects.clear();
        for (const element of p.healthbars.values()) element.remove();
        p.healthbars.clear();
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
            const hostile = (shot.collisionMask & PLAYER_COLLISION_GROUP) !== 0;
            // Compact coral diamonds read as danger, separate from long mint player shots.
            eid = box(world, hostile ? arena.materials.hostileShot : arena.materials.shot,
                [shot.x, 0.55, shot.z], hostile ? [0.32, 0.22, 0.32] : [0.14, 0.14, 0.65]);
            world.add(eid, SessionEntity);
            const yaw = hostile ? Math.PI / 4 : Math.atan2(shot.velocityX, shot.velocityZ);
            pose.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
            p.projectiles.set(shot.id, eid);
        }
        const a = world.time.paused ? 1 : world.time.fixedAlpha;
        pose.translation.set(eid, shot.previousX + (shot.x - shot.previousX) * a, 0.55, shot.previousZ + (shot.z - shot.previousZ) * a);
        // A ricochet waits visibly at impact and releases only on a new beat.
        const scale = shot.waitingForBounce
            ? 1.25 + (visuals.motionAllowed ? visuals.frame.beatPulse * 0.2 : 0) : 1;
        const hostile = (shot.collisionMask & PLAYER_COLLISION_GROUP) !== 0;
        pose.scale.set(eid, (hostile ? 0.32 : 0.14) * scale,
            (hostile ? 0.22 : 0.14) * scale, (hostile ? 0.32 : 0.65) * scale);
        if (!hostile && !shot.waitingForBounce) {
            const yaw = Math.atan2(shot.velocityX, shot.velocityZ);
            pose.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        }
    }
    for (const [id, eid] of p.projectiles) {
        if (!live.has(id)) { world.destroy(eid); p.projectiles.delete(id); }
    }
    const liveEnemies = new Set<number>();
    const liveHealthbars = new Set<number>();
    const liveBodies = new Set<number>();
    const bounds = typeof document === "undefined" ? undefined : document.querySelector("canvas")?.getBoundingClientRect();
    for (const enemy of s.combat.enemies) {
        const body = s.enemyBodies.get(enemy.id);
        if (body === undefined) continue;
        liveBodies.add(body);
        liveHealthbars.add(enemy.id);
        let bar = p.healthbars.get(enemy.id);
        if (!bar && p.layer) {
            bar = document.createElement("div");
            bar.className = "enemy-healthbar";
            bar.dataset.enemyId = String(enemy.id);
            bar.dataset.enemyKind = enemy.kind;
            const fill = document.createElement("div");
            fill.className = "enemy-healthbar-fill";
            bar.append(fill);
            p.layer.append(bar);
            p.healthbars.set(enemy.id, bar);
        }
        if (bar) {
            const x = pose.translation.x.get(body), z = pose.translation.z.get(body);
            const lift = surfaceLift(x, z);
            const pixel = worldToViewport(world, arena.camera,
                [x, 1.8 + lift, z]);
            bar.dataset.surfaceLift = String(lift);
            const health = String(enemy.health), maxHealth = String(enemy.maxHealth);
            if (bar.dataset.health !== health || bar.dataset.maxHealth !== maxHealth) {
                bar.dataset.health = health;
                bar.dataset.maxHealth = maxHealth;
                bar.dataset.damaged = String(enemy.health < enemy.maxHealth);
                const fill = bar.firstElementChild as HTMLElement;
                fill.style.transform = `scaleX(${Math.max(0, Math.min(1, enemy.health / enemy.maxHealth))})`;
            }
            bar.hidden = !pixel || !bounds;
            if (pixel && bounds) {
                bar.style.transform = `translate(${bounds.left + pixel[0]}px, ${bounds.top + pixel[1]}px) translate(-50%, -50%)`;
            }
        }
        if (enemy.kind === "chaser") continue;
        liveEnemies.add(enemy.id);
        let accents = p.enemyAccents.get(enemy.id);
        if (!accents) {
            // Three spokes for the spinner; one barrel and two swept fins for the ranger.
            accents = Array.from({ length: 3 }, (_, i) => {
                const scale: [number, number, number] = enemy.kind === "spinner"
                    ? [0.2, 0.16, 0.85] : i === 0 ? [0.19, 0.17, 0.85] : [0.18, 0.15, 0.5];
                const eid = box(world, enemyMaterial(arena, enemy.kind), [enemy.x, 1.12, enemy.z], scale);
                world.add(eid, SessionEntity);
                return eid;
            });
            p.enemyAccents.set(enemy.id, accents);
        }
        // Use the combat heading: musical turns for spinners, tracked aim for rangers.
        // No cosmetic spin, flashing or physics-body transform writes are needed.
        for (let i = 0; i < accents.length; i++) {
            const eid = accents[i]!;
            const angle = enemy.heading + (enemy.kind === "spinner"
                ? i * Math.PI * 2 / 3 : i === 0 ? 0 : (i === 1 ? -1 : 1) * Math.PI * 0.75);
            const offset = enemy.kind === "spinner" || i === 0 ? 0.43 : 0.52;
            pose.translation.set(eid,
                pose.translation.x.get(body) + Math.sin(angle) * offset, 1.12,
                pose.translation.z.get(body) + Math.cos(angle) * offset);
            pose.rotation.set(eid, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2));
        }
    }
    for (const [id, accents] of p.enemyAccents) {
        if (!liveEnemies.has(id)) {
            for (const eid of accents) world.destroy(eid);
            p.enemyAccents.delete(id);
        }
    }
    for (const [id, bar] of p.healthbars) {
        if (!liveHealthbars.has(id)) { bar.remove(); p.healthbars.delete(id); }
    }
    for (const eid of p.flashing) if (!liveBodies.has(eid)) p.flashing.delete(eid);
    const effects = new Set<number>();
    for (const effect of visuals.director.feedback) {
        effects.add(effect.id);
        let element = p.effects.get(effect.id);
        if (!element && p.layer) {
            element = document.createElement("span");
            element.className = `damage-number ${effect.critical ? "critical" : ""} ${effect.kind === "player-hit" ? "player-damage" : ""}`;
            element.dataset.eventId = String(effect.id);
            element.dataset.birth = String(effect.birth);
            element.dataset.kind = effect.kind;
            element.dataset.amount = String(effect.amount);
            element.dataset.critical = String(effect.critical);
            if (effect.targetId !== undefined) {
                element.dataset.targetId = String(effect.targetId);
                element.dataset.enemyId = String(effect.targetId);
            }
            element.textContent = `${effect.critical ? "✦ " : ""}${effect.amount}`;
            p.layer.append(element);
            p.effects.set(effect.id, element);
        }
        const numberPose = damageNumberPose(visuals.timeline, effect, s.visualPosition, visuals.motionAllowed);
        const lift = surfaceLift(effect.x, effect.z);
        const pixel = worldToViewport(world, arena.camera, [effect.x, 2.45 + numberPose.rise + lift, effect.z]);
        if (element) {
            element.dataset.surfaceLift = String(lift);
            element.dataset.progress = String(numberPose.progress);
            element.dataset.rise = String(numberPose.rise);
            element.dataset.scale = String(numberPose.scale);
            element.hidden = !pixel || !bounds;
            if (pixel && bounds) {
                element.style.transform = `translate(${bounds.left + pixel[0]}px, ${bounds.top + pixel[1]}px) translate(-50%, -50%) scale(${numberPose.scale})`;
                element.style.opacity = String(numberPose.opacity);
            }
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
                (effect.targetId === undefined
                    ? Math.hypot(effect.x - enemy.x, effect.z - enemy.z) < 1
                    : effect.targetId === enemy.id) &&
                feedbackAge(visuals.timeline, effect, s.visualPosition) < 0.3);
        if (flash !== p.flashing.has(eid)) {
            world.storage(MeshMaterial).material.set(eid,
                (flash ? arena.materials.hit : enemyMaterial(arena, enemy.kind)).material);
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
        style.textContent = `
            .damage-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0}
            .enemy-healthbar,.damage-number{position:absolute;left:0;top:0}
            /* Each bounded, tiny bar moves every frame. Cache its painted surface
               so following an enemy only updates the compositor transform. */
            .enemy-healthbar{box-sizing:border-box;width:32px;height:5px;border:1px solid #06100fe6;border-radius:2px;background:#081310e6;box-shadow:0 1px 3px #0009;opacity:.7;will-change:transform}
            .enemy-healthbar[data-damaged=true]{opacity:1}
            .enemy-healthbar-fill{height:100%;border-radius:1px;background:#b8e4cf;transform-origin:left center}
            .damage-number{z-index:1;white-space:nowrap;font:700 16px ui-monospace,monospace;color:#e5fff5;text-shadow:0 2px 4px #000;transform-origin:center}
            .damage-number.critical{color:#ffe0a3;font-size:21px}
            .damage-number.player-damage{color:#ff817a}
        `;
        document.head.append(style);
        world.onDispose(() => { state.layer?.remove(); style.remove(); });
    },
    systems: [{ name: "Beatshooter/Presentation", group: "simulation", after: [PresentPlayer, PresentMusicalVisuals], update: present }],
};
