import {
    Camera, lookAtRotation, Materials, StandardMaterial, Transform,
    type Plugin, type System,
} from "@dylanebert/shallot";
import { AlphaMode } from "@dylanebert/shallot/standard/rendering";
import { Arena, box } from "../arena";
import { MusicVisuals, PresentMusicalVisuals, SampleMusicalVisuals } from "../music-visuals";
import { PresentPlayer } from "../player";
import { isArenaPhase, Session } from "../session";
import { SectionEffects, NO_SECTION_FRAME } from "./runtime";
import { SectionTransitionTimeline, type RGB } from "./state";

export { SectionEffects } from "./runtime";

const colorHex = (rgb: RGB): number =>
    (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255);
const CAMERA_ROTATION = lookAtRotation(0, 32, 19, 0, 0, 0);

export const SampleSectionEffects: System = {
    name: "Beatshooter/SampleSectionEffects", group: "setup", after: [SampleMusicalVisuals],
    update(world) {
        const session = world.resource(Session), state = world.resource(SectionEffects);
        const visuals = world.resource(MusicVisuals);
        const structure = session.loaded?.structure;
        if (state.generation !== session.generation || state.track !== session.track || state.structure !== structure) {
            state.timeline = new SectionTransitionTimeline(structure, session.track.beats);
            state.generation = session.generation;
            state.track = session.track;
            state.structure = structure;
        }
        const visible = isArenaPhase(session.phase);
        // Section boundaries belong to the recording itself, not visual calibration.
        state.frame = visible ? state.timeline.sample(session.position) : NO_SECTION_FRAME;
        state.motionAllowed = visible && visuals.motionAllowed;
        const moving = state.frame.active && state.frame.musical && state.motionAllowed;
        const calm = session.preferences.settings.effectsIntensity === "calm";
        const direction = state.frame.index % 2 ? 1 : -1;
        state.mapRoll = moving ? direction * (calm
            ? Math.sin(state.frame.progress * Math.PI * 2) * 0.08
            : state.frame.roll) : 0;
        // Lower the tumbling floor just enough to keep every corner beneath
        // the play plane. It cannot sweep through or hide the combat entities.
        state.mapDrop = 18.5 * Math.abs(Math.sin(state.mapRoll)) + 0.4 * (1 - Math.cos(state.mapRoll));
        state.roll = 0;
        state.zoom = 1;
        state.strength = moving ? (calm ? 0.22 : 0.85) : 0;
    },
};

export const PresentSectionEffects: System = {
    name: "Beatshooter/PresentSectionEffects", group: "simulation",
    after: [PresentPlayer], before: [PresentMusicalVisuals],
    update(world) {
        const state = world.resource(SectionEffects), arena = world.resource(Arena);
        const transform = world.storage(Transform), camera = world.storage(Camera);
        if (arena.camera >= 0 && world.has(arena.camera, Camera)) {
            transform.rotation.set(arena.camera, ...CAMERA_ROTATION);
            camera.size.set(arena.camera, 17);
            camera.clearColor.set(arena.camera, colorHex(state.frame.palette.clearColor));
        }
        const c = Math.cos(state.mapRoll), s = Math.sin(state.mapRoll);
        for (const [eid, [x, y, z]] of arena.mapVisuals) {
            transform.translation.set(eid, x * c - y * s, x * s + y * c - state.mapDrop, z);
            transform.rotation.set(eid, 0, 0, Math.sin(state.mapRoll / 2), Math.cos(state.mapRoll / 2));
        }
        if (!state.portalMaterial) return;
        const visible = state.strength > 0 && state.frame.envelope > 0;
        if (!visible) {
            if (state.portalsVisible) {
                for (const eid of state.portals) transform.scale.set(eid, 0, 0, 0);
                state.portalsVisible = false;
            }
            return;
        }
        state.portalsVisible = true;
        const color = state.frame.palette.accent;
        world.resource(Materials).update(state.portalMaterial, {
            baseColor: [color[0] * 1.7, color[1] * 1.7, color[2] * 1.7, 0.38],
        });
        // Three reusable frames outside the arena create the depth of a portal.
        // Their widths dissolve at wrap boundaries; no mesh is spawned mid-effect.
        const quality = world.resource(Session).preferences.settings.graphics;
        for (let ring = 0; ring < 3; ring++) {
            const phase = (state.frame.progress + ring / 3) % 1;
            const radius = 19.5 + phase * 25;
            const width = (quality === "high" || ring === 0)
                ? state.strength * state.frame.envelope * Math.sin(phase * Math.PI) ** 2 * 0.22 : 0;
            for (let edge = 0; edge < 4; edge++) {
                const eid = state.portals[ring * 4 + edge]!;
                const horizontal = edge % 2 === 0;
                const sign = edge < 2 ? -1 : 1;
                transform.translation.set(eid, horizontal ? 0 : sign * radius, -0.7, horizontal ? sign * radius : 0);
                transform.scale.set(eid, horizontal ? radius * 2 : width, 0.025, horizontal ? width : radius * 2);
            }
        }
    },
};

export const SectionEffectsPlugin: Plugin = {
    name: "Beatshooter/SectionEffects",
    initialize(world) {
        const state = world.resource(SectionEffects);
        state.portalMaterial = world.resource(Materials).add(
            StandardMaterial({ baseColor: [0.1, 0.3, 0.3, 0.38], unlit: true }),
            { alphaMode: AlphaMode.Blend },
        );
        state.portals = Array.from({ length: 12 }, () => box(world, state.portalMaterial!, [0, -0.7, 0], [0, 0, 0]));
    },
    systems: [SampleSectionEffects, PresentSectionEffects],
};
