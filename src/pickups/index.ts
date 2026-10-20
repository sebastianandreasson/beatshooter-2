import {
    Materials, Meshes, MeshInstance, MeshMaterial, MeshPlugin, StandardMaterial, Transform,
    type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { box } from "../arena";
import { MusicVisuals, PresentMusicalVisuals } from "../music-visuals";
import { isArenaPhase, Session, SessionEntity } from "../session";
import type { PickupKind } from "./state";
import { ringGeometry } from "../presentation/ring-geometry";

export const PickupPresentation: Resource<{
    generation: number;
    drops: Map<number, number[]>;
    waves: Map<number, number>;
    ring?: MeshHandle;
    colors?: Record<PickupKind, MaterialHandle>;
    base?: MaterialHandle;
    white?: MaterialHandle;
    notice?: HTMLElement;
}> = { create: () => ({ generation: -1, drops: new Map(), waves: new Map() }) };

// Top-facing plus, horseshoe magnet and bomb/fuse silhouettes stay readable without bloom.
function icon(kind: PickupKind): readonly (readonly [number, number, number, number, boolean?])[] {
    if (kind === "health") return [[0, 0, 0.95, 0.28], [0, 0, 0.28, 0.95]];
    if (kind === "magnet") return [
        [-0.34, 0, 0.24, 0.8], [0.34, 0, 0.24, 0.8], [0, 0.3, 0.9, 0.25],
        [-0.34, -0.36, 0.24, 0.22, true], [0.34, -0.36, 0.24, 0.22, true],
    ];
    return [[0, 0.12, 0.65, 0.65], [0, -0.38, 0.14, 0.35, true], [0.12, -0.6, 0.22, 0.15, true]];
}

function ring(world: World, material: MaterialHandle, mesh: MeshHandle): number {
    const eid = box(world, material, [0, 0, 0], [0, 0, 0]);
    world.storage(MeshInstance).mesh.set(eid, mesh);
    world.add(eid, SessionEntity);
    return eid;
}

export const PresentPickups: System = {
    name: "Beatshooter/PresentPickups", group: "simulation", after: [PresentMusicalVisuals],
    update(world) {
        const session = world.resource(Session), state = world.resource(PickupPresentation);
        if (state.generation !== session.generation) {
            state.drops.clear(); state.waves.clear(); state.generation = session.generation;
        }
        if (!state.colors || state.ring === undefined || state.base === undefined || state.white === undefined) return;
        const visible = isArenaPhase(session.phase), pickups = session.combat.pickups;
        const pose = world.storage(Transform), visuals = world.resource(MusicVisuals);
        const pulse = visuals.motionAllowed && visuals.frame.active ? visuals.frame.beatPulse * visuals.intensity : 0;
        const live = new Set<number>();
        for (const drop of visible ? pickups.drops : []) {
            live.add(drop.id);
            let parts = state.drops.get(drop.id);
            const shape = icon(drop.kind);
            if (!parts) {
                parts = [ring(world, state.colors[drop.kind], state.ring)];
                for (const material of [state.base, ...shape.map(part => part[4] ? state.white! : state.colors![drop.kind])]) {
                    const eid = box(world, material, [0, 0, 0], [0, 0, 0]);
                    world.add(eid, SessionEntity);
                    parts.push(eid);
                }
                state.drops.set(drop.id, parts);
            }
            pose.translation.set(parts[0]!, drop.x, 0.06, drop.z);
            pose.scale.set(parts[0]!, 1.05, 1, 1.05);
            pose.translation.set(parts[1]!, drop.x, 0.32 + pulse * 0.04, drop.z);
            pose.scale.set(parts[1]!, 1.25, 0.16, 1.25);
            shape.forEach(([x, z, width, depth], index) => {
                pose.translation.set(parts![index + 2]!, drop.x + x, 0.47 + pulse * 0.04, drop.z + z);
                pose.scale.set(parts![index + 2]!, width, 0.13, depth);
            });
        }
        for (const [id, parts] of state.drops) {
            if (!live.has(id)) { parts.forEach(eid => world.destroy(eid)); state.drops.delete(id); }
        }
        const waves = new Set<number>();
        for (const wave of visible ? pickups.waves : []) {
            waves.add(wave.id);
            let eid = state.waves.get(wave.id);
            if (eid === undefined) {
                eid = ring(world, state.colors.bomb, state.ring);
                state.waves.set(wave.id, eid);
            }
            // This ring communicates the actual damage front, including with effects Off.
            pose.translation.set(eid, wave.x, 0.25, wave.z);
            pose.scale.set(eid, wave.radius, 1, wave.radius);
        }
        for (const [id, eid] of state.waves) {
            if (!waves.has(id)) { world.destroy(eid); state.waves.delete(id); }
        }
        if (state.notice) {
            const notice = pickups.notice;
            state.notice.hidden = !visible || !notice || pickups.position - notice.at > 2;
            if (!state.notice.hidden && notice) {
                const text = notice.kind === "health" ? `HEALTH +${notice.amount}`
                    : notice.kind === "magnet" ? `MAGNET · ${notice.amount} XP drawn in` : `BOMB · ${notice.amount} damage`;
                if (state.notice.textContent !== text) state.notice.textContent = text;
            }
        }
    },
};

export const PickupsPlugin: Plugin = {
    name: "Beatshooter/Pickups", dependencies: [MeshPlugin],
    initialize(world) {
        const state = world.resource(PickupPresentation), materials = world.resource(Materials);
        state.ring = world.resource(Meshes).add({ name: "Pickup and bomb ring", ...ringGeometry() });
        const color = (rgb: [number, number, number]) => materials.add(StandardMaterial({
            baseColor: [...rgb, 1], emissive: rgb.map(value => value * 1.2) as [number, number, number], unlit: true,
        }));
        state.colors = { health: color([0.2, 0.95, 0.45]), magnet: color([0.12, 0.65, 1]), bomb: color([1, 0.5, 0.12]) };
        state.white = color([0.85, 0.93, 1]);
        state.base = materials.add(StandardMaterial({ baseColor: [0.025, 0.045, 0.065, 1], perceptualRoughness: 0.6 }));
        if (typeof document !== "undefined") {
            const notice = document.createElement("div");
            notice.className = "bs-pickup-notice";
            notice.hidden = true; notice.setAttribute("role", "status");
            notice.style.cssText = "position:fixed;left:50%;top:19%;transform:translateX(-50%);"
                + "padding:8px 14px;border:1px solid #86b4c8;border-radius:6px;background:#08141de8;"
                + "color:#e7f7ff;font:700 16px system-ui;pointer-events:none;z-index:1;text-align:center";
            document.body.append(notice); state.notice = notice;
            world.onDispose(() => notice.remove());
        }
    },
    systems: [PresentPickups],
};
