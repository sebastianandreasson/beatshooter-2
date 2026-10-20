import {
    lookAtRotation, Materials, StandardMaterial, Transform,
    type Plugin, type Resource, type System,
} from "@dylanebert/shallot";
import type { SectionAnalysis } from "../analysis/sections";
import { ArenaPlugin, box } from "../arena";
import { MusicVisuals } from "../music-visuals";
import { PresentSectionEffects, SampleSectionEffects } from "../section-effects";
import { isArenaPhase, Session } from "../session";
import type { TrackManifest } from "../tracks";
import { StarfieldTimeline } from "./motion";
import { createStarSeeds, LOW_DETAIL_STAR_COUNT, sampleStarPose, type StarPose, type StarSeed } from "./pose";

export const Starfield: Resource<{
    generation: number;
    track?: TrackManifest;
    structure?: SectionAnalysis;
    timeline: StarfieldTimeline;
    distance: number;
    speed: number;
    boost: number;
    motionAllowed: boolean;
    stars: number[];
    seeds: StarSeed[];
    visibleStars: number;
    scratch: StarPose;
}> = {
    create: () => ({
        generation: -1, timeline: new StarfieldTimeline(undefined, []),
        distance: 0, speed: 0, boost: 0, motionAllowed: false,
        stars: [], seeds: createStarSeeds(), visibleStars: 0,
        scratch: { x: 0, y: 0, z: 0, width: 0, length: 0 },
    }),
};

export const SampleStarfield: System = {
    name: "Beatshooter/SampleStarfield", group: "setup", after: [SampleSectionEffects],
    update(world) {
        const session = world.resource(Session), state = world.resource(Starfield);
        const structure = session.loaded?.structure;
        if (state.generation !== session.generation || state.track !== session.track || state.structure !== structure) {
            state.timeline = new StarfieldTimeline(structure, session.track.beats);
            state.generation = session.generation;
            state.track = session.track;
            state.structure = structure;
        }
        const visuals = world.resource(MusicVisuals);
        state.motionAllowed = isArenaPhase(session.phase) && visuals.motionAllowed;
        if (!state.motionAllowed) {
            state.distance = state.speed = state.boost = 0;
            return;
        }
        const frame = state.timeline.sample(session.position);
        const gain = session.preferences.settings.effectsIntensity === "calm" ? 0.18 : 1;
        const base = Number.isFinite(session.position) ? Math.max(0, session.position) : 0;
        state.distance = base + (frame.distance - base) * gain;
        state.boost = frame.boost * gain;
        state.speed = 1 + 14 * state.boost;
    },
};

export const PresentStarfield: System = {
    name: "Beatshooter/PresentStarfield", group: "simulation", after: [PresentSectionEffects],
    update(world) {
        const state = world.resource(Starfield);
        const transform = world.storage(Transform);
        const count = world.resource(Session).preferences.settings.graphics === "high"
            ? state.stars.length : Math.min(LOW_DETAIL_STAR_COUNT, state.stars.length);
        state.visibleStars = 0;
        for (let index = 0; index < state.stars.length; index++) {
            const eid = state.stars[index]!;
            if (index >= count) {
                transform.scale.set(eid, 0, 0, 0);
                continue;
            }
            const pose = sampleStarPose(state.seeds[index]!, state.distance, state.boost, state.scratch);
            transform.translation.set(eid, pose.x, pose.y, pose.z);
            transform.scale.set(eid, pose.width, pose.length, 0.018);
            if (pose.width > 0.001) state.visibleStars++;
        }
    },
};

export const StarfieldPlugin: Plugin = {
    name: "Beatshooter/Starfield",
    dependencies: [ArenaPlugin],
    initialize(world) {
        const state = world.resource(Starfield), materials = world.resource(Materials);
        const colors: [number, number, number, number][] = [
            [0.035, 0.065, 0.085, 1],
            [0.065, 0.105, 0.13, 1],
            [0.12, 0.16, 0.18, 1],
        ];
        const handles = colors.map(baseColor => materials.add(StandardMaterial({ baseColor, unlit: true })));
        const [x, y, z, w] = lookAtRotation(0, 32, 19, 0, 0, 0);
        const transform = world.storage(Transform);
        for (const seed of state.seeds) {
            const pose = sampleStarPose(seed, 0, 0, state.scratch);
            const eid = box(world, handles[seed.layer]!, [pose.x, pose.y, pose.z], [pose.width, pose.length, 0.018]);
            // Local Y follows the star's radial heading; local Z faces the camera.
            const half = (seed.angle - Math.PI / 2) * 0.5;
            const s = Math.sin(half), c = Math.cos(half);
            transform.rotation.set(eid, x * c + y * s, y * c - x * s, z * c + w * s, w * c - z * s);
            state.stars.push(eid);
        }
        state.visibleStars = state.stars.length;
    },
    systems: [SampleStarfield, PresentStarfield],
};
