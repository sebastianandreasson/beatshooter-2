import { Camera, CameraMode, type Plugin, type System, type World } from "@dylanebert/shallot";
import { Arena } from "../arena";
import { MusicVisuals, PresentMusicalVisuals, SampleMusicalVisuals } from "../music-visuals";
import { PresentPlayer, SamplePlayer } from "../player";
import { isArenaPhase, Session } from "../session";
import { SectionEffects, NO_SECTION_FRAME } from "./runtime";
import { SectionTransitionTimeline, type RGB } from "./state";

export { SectionEffects } from "./runtime";

const colorHex = (rgb: RGB): number =>
    (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255);

/** Set an absolute lens size before input reads it; never scale last frame's result. */
function sampleCameraZoom(world: World): void {
    const state = world.resource(SectionEffects), arena = world.resource(Arena);
    const camera = world.storage(Camera);
    const previous = state.zoomCamera ? world.resolve(state.zoomCamera) : 0;
    const current = arena.camera >= 0 && world.has(arena.camera, Camera)
        && camera.mode.get(arena.camera) === CameraMode.Orthographic ? arena.camera : 0;
    if (current !== previous) {
        if (previous && world.has(previous, Camera)) camera.size.set(previous, state.baseCameraSize);
        state.zoomCamera = current ? world.ref(current) : undefined;
        if (current) state.baseCameraSize = camera.size.get(current);
    }
    const impact = state.motionAllowed && Number.isFinite(state.frame.impact)
        ? Math.max(0, Math.min(1, state.frame.impact)) : 0;
    const calm = world.resource(Session).preferences.settings.effectsIntensity === "calm";
    state.zoomScale = current ? 1 + impact * (calm ? 0.01 : 0.05) : 1;
    if (current) camera.size.set(current, state.baseCameraSize / state.zoomScale);
}

export const SampleSectionEffects: System = {
    name: "Beatshooter/SampleSectionEffects", group: "setup",
    after: [SampleMusicalVisuals], before: [SamplePlayer],
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
        state.strength = moving ? (calm ? 0.22 : 0.85) : 0;
        sampleCameraZoom(world);
    },
};

export const PresentSectionEffects: System = {
    name: "Beatshooter/PresentSectionEffects", group: "simulation",
    after: [PresentPlayer], before: [PresentMusicalVisuals],
    update(world) {
        const state = world.resource(SectionEffects), arena = world.resource(Arena);
        const camera = world.storage(Camera);
        if (arena.camera >= 0 && world.has(arena.camera, Camera)) {
            let color = state.frame.palette.clearColor;
            if (state.strength > 0 && state.frame.active) {
                // The outside background changes as the front reaches the arena's
                // edges, following the same outward color sweep as the floor.
                const edge = Math.max(0, Math.min(1, (state.frame.waveProgress - 0.55) / 0.4));
                const amount = edge * edge * (3 - 2 * edge);
                const from = state.frame.from.clearColor, to = state.frame.to.clearColor;
                color = [
                    from[0] + (to[0] - from[0]) * amount,
                    from[1] + (to[1] - from[1]) * amount,
                    from[2] + (to[2] - from[2]) * amount,
                ];
            }
            camera.clearColor.set(arena.camera, colorHex(color));
        }
    },
};

export const SectionEffectsPlugin: Plugin = {
    name: "Beatshooter/SectionEffects",
    initialize(world) {
        const state = world.resource(SectionEffects), camera = world.storage(Camera);
        world.onDispose(() => {
            // These accessors remain valid during disposal; resource lookup does not.
            const eid = state.zoomCamera ? world.resolve(state.zoomCamera) : 0;
            if (eid) camera.size.set(eid, state.baseCameraSize);
            state.zoomScale = 1;
            state.zoomCamera = undefined;
        });
    },
    systems: [SampleSectionEffects, PresentSectionEffects],
};
