import {
    Materials, MeshMaterial, StandardMaterial, Transform, type Plugin, type Resource, type World,
} from "@dylanebert/shallot";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { box } from "../arena";
import { PresentMusicalVisuals } from "../music-visuals";
import { PresentPlayer } from "../player";
import { isArenaPhase, Session } from "../session";
import { GRID_HAZARD_CAP } from "./state";

export { createHazards, gridTiles, intersectsTile, warningWindow, advanceHazards } from "./state";

/** Fixed pools survive song transitions, with no colliders or input ownership. */
export const EncounterPresentation: Resource<{
    tiles: number[][];
    lanes: number[][];
    elite: number[];
    warning?: MaterialHandle;
    active?: MaterialHandle;
    title?: HTMLElement;
    initialized: boolean;
    visibleCount: number;
}> = { create: () => ({ tiles: [], lanes: [], elite: [], initialized: false, visibleCount: 0 }) };

function allocate(world: World): void {
    const state = world.resource(EncounterPresentation);
    if (state.initialized) return;
    const materials = world.resource(Materials);
    state.warning = materials.add(StandardMaterial({ baseColor: [0.95, 0.64, 0.2, 1], unlit: true }));
    state.active = materials.add(StandardMaterial({ baseColor: [0.85, 0.18, 0.16, 1], unlit: true }));
    const mesh = () => box(world, state.warning!, [0, 0, 0], [0, 0, 0]);
    state.tiles = Array.from({ length: GRID_HAZARD_CAP }, () => Array.from({ length: 7 }, mesh));
    state.lanes = Array.from({ length: 6 }, () => Array.from({ length: 3 }, mesh));
    state.elite = Array.from({ length: 6 }, mesh);
    state.initialized = true;
}

function present(world: World): void {
    const session = world.resource(Session), e = session.combat.encounter;
    const state = world.resource(EncounterPresentation);
    const visible = isArenaPhase(session.phase) && e && !e.stopped;
    if (visible) allocate(world);
    const transform = world.storage(Transform), material = world.storage(MeshMaterial);
    state.visibleCount = 0;
    const all = [...state.tiles.flat(), ...state.lanes.flat(), ...state.elite];
    for (const eid of all) transform.scale.set(eid, 0, 0, 0);
    if (state.title) state.title.hidden = true;
    if (!visible) return;
    const set = (
        eid: number, x: number, y: number, z: number,
        width: number, depth: number, yaw = 0, active = false,
    ) => {
        transform.translation.set(eid, x, y, z);
        transform.scale.set(eid, width, 0.035, depth);
        transform.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        material.material.set(eid, (active ? state.active! : state.warning!).material);
        state.visibleCount++;
    };
    const announce = (text: string) => {
        if (!state.title) return;
        if (state.title.textContent !== text) state.title.textContent = text;
        state.title.hidden = session.phase === "paused";
    };
    const grid = e.hazards.grid;
    if (grid && session.position < grid.endTime) {
        const active = grid.phase === "active";
        grid.tiles.forEach((tile, i) => {
            const parts = state.tiles[i]!, halfX = tile.width / 2, halfZ = tile.depth / 2;
            set(parts[0]!, tile.x, 0.015, tile.z - halfZ, tile.width, 0.1, 0, active);
            set(parts[1]!, tile.x, 0.015, tile.z + halfZ, tile.width, 0.1, 0, active);
            set(parts[2]!, tile.x - halfX, 0.015, tile.z, 0.1, tile.depth, 0, active);
            set(parts[3]!, tile.x + halfX, 0.015, tile.z, 0.1, tile.depth, 0, active);
            // A crossed outline is recognizable without glow, color or motion.
            set(parts[4]!, tile.x, 0.02, tile.z, 0.08, tile.depth * 1.3, Math.PI / 4, active);
            set(parts[5]!, tile.x, 0.02, tile.z, 0.08, tile.depth * 1.3, -Math.PI / 4, active);
            if (active) set(parts[6]!, tile.x, -0.05, tile.z, tile.width, tile.depth, 0, true);
        });
        if (!active) announce("PULSE GRID · Clear the marked tiles");
    }
    let laneIndex = 0;
    for (const warning of e.rangerWarnings.values()) {
        if (laneIndex >= state.lanes.length) break;
        const parts = state.lanes[laneIndex++]!, { origin, direction } = warning;
        const edge = session.combat.tuning.arenaHalfExtent;
        const tx = direction.x > 0 ? (edge - origin.x) / direction.x
            : direction.x < 0 ? (-edge - origin.x) / direction.x : Infinity;
        const tz = direction.z > 0 ? (edge - origin.z) / direction.z
            : direction.z < 0 ? (-edge - origin.z) / direction.z : Infinity;
        const length = Math.max(0, Math.min(tx, tz)), yaw = Math.atan2(direction.x, direction.z);
        for (let line = 0; line < 3; line++) {
            const offset = (line - 1) * 0.35;
            set(parts[line]!, origin.x + direction.x * length / 2 + direction.z * offset,
                0.04, origin.z + direction.z * length / 2 - direction.x * offset,
                line === 1 ? 0.08 : 0.035, length, yaw);
        }
    }
    const elite = session.combat.enemies.find(enemy => enemy.id === e.eliteId);
    const pending = session.combat.pendingSpawns.find(spawn => spawn.enemy.id === e.eliteId);
    const source = elite ?? pending?.enemy;
    if (source) {
        for (let i = 0; i < state.elite.length; i++) {
            const angle = source.heading + i * Math.PI / 3;
            set(state.elite[i]!, source.x + Math.sin(angle) * 0.8, 1.25,
                source.z + Math.cos(angle) * 0.8, 0.13, 0.8, angle);
        }
        if (pending) announce("ELITE INBOUND · Six-way fire");
    }
}

export const EncounterPresentationPlugin: Plugin = {
    name: "Beatshooter/Encounters",
    initialize(world) {
        if (typeof document === "undefined") return;
        const state = world.resource(EncounterPresentation);
        const title = document.createElement("div");
        title.className = "encounter-warning";
        title.hidden = true;
        title.setAttribute("role", "status");
        title.style.cssText = "position:fixed;left:50%;top:27%;transform:translateX(-50%);max-width:85vw;"
            + "padding:8px 14px;border:1px solid #e8af57;border-radius:6px;background:#121813ed;"
            + "color:#ffe0a6;font:700 15px system-ui;text-align:center;pointer-events:none;z-index:1";
        state.title = title;
        document.body.append(title);
        world.onDispose(() => title.remove());
    },
    systems: [{
        name: "Beatshooter/PresentEncounters", group: "simulation",
        after: [PresentPlayer, PresentMusicalVisuals], update: present,
    }],
};
