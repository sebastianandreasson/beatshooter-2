import { Meshes, MeshInstance, MeshPlugin, Transform, type Plugin, type Resource, type System, type World } from "@dylanebert/shallot";
import { AlphaMode, materialType, MaterialPlugin, type MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import * as d from "typegpu/data";
import * as std from "typegpu/std";
import { sampleEnergy } from "../analysis/energy";
import { createFeatureSample, sampleFeatures } from "../analysis/features";
import { box } from "../arena";
import { MusicVisuals } from "../music-visuals";
import { PresentSectionEffects, SectionEffects } from "../section-effects";
import { isArenaPhase, Session } from "../session";
import { auroraPoint, polygonRadius, sampleStageFrame, smooth, type StageFrame } from "./state";

// A separate unlit material keeps the background out of the arena's deformation
// pass. The real floor depth-occludes everything below it; no actors are echoed.
const StageParameters = d.struct({ color: d.vec4f, softness: d.f32 });
export const StageMaterial = materialType({
    name: "Beatshooter/MusicStage",
    parameters: StageParameters,
    defaults: { color: d.vec4f(0, 0, 0, 1), softness: 0 },
    fragmentInputs: { localPos: true },
    fragment: context => {
        "use gpu";
        const distance = std.abs(context.localPos.x) * 2;
        const halo = std.pow(std.max(0, 1 - distance), 2);
        const core = std.exp(-distance * distance * 60);
        const soft = context.parameters.softness;
        const light = std.mix(1, 0.35 + core * 0.65, soft);
        return d.vec4f(std.mul(context.parameters.color.xyz, light),
            context.parameters.color.w * std.mix(1, halo, soft));
    },
});
const StageRegistration = MaterialPlugin(StageMaterial);
export const STAGE_CAPACITY = { spectrum: 64, lasers: 24, aurora: 96, particles: 32, echoes: 72, geometry: 48 } as const;
type Layer = keyof typeof STAGE_CAPACITY;
const LAYERS = Object.keys(STAGE_CAPACITY) as Layer[];

export const MusicStage: Resource<{
    entities: Record<Layer, number[]>;
    materials: Partial<Record<Layer, MaterialHandle>>;
    features: ReturnType<typeof createFeatureSample>;
    frame?: StageFrame;
    counts: Record<Layer, number>;
    cpuMs: number;
    hasFeatures: boolean;
}> = {
    create: () => ({
        entities: { spectrum: [], lasers: [], aurora: [], particles: [], echoes: [], geometry: [] },
        materials: {}, features: createFeatureSample(), counts: { spectrum: 0, lasers: 0, aurora: 0, particles: 0, echoes: 0, geometry: 0 },
        cpuMs: 0, hasFeatures: false,
    }),
};

/** Fixed pools, no physics components, no allocation of materials on accents. */
export function createStagePool(world: World, handles: Record<Layer, MaterialHandle>): void {
    const state = world.resource(MusicStage);
    for (const layer of LAYERS) {
        state.materials[layer] = handles[layer];
        for (let i = 0; i < STAGE_CAPACITY[layer]; i++) state.entities[layer].push(box(world, handles[layer], [0, -2, 0], [0, 0, 0]));
    }
}

export const PresentMusicStage: System = {
    name: "Beatshooter/PresentMusicStage", group: "simulation", after: [PresentSectionEffects],
    update(world) {
        const visuals = world.resource(MusicVisuals), started = visuals.profileCpu ? performance.now() : 0;
        const state = world.resource(MusicStage), session = world.resource(Session), sections = world.resource(SectionEffects);
        const section = sections.frame, settings = session.preferences.settings, curve = session.loaded?.energy;
        const energy = sampleEnergy(curve, session.visualPosition);
        sampleFeatures(curve?.features, curve?.duration ?? 0, session.visualPosition, state.features);
        state.hasFeatures = !!curve?.features;
        const previous = session.loaded?.structure?.sections[section.index - 1]?.label;
        const current = session.loaded?.structure?.sections[section.index];
        const frame = sampleStageFrame({
            visible: isArenaPhase(session.phase) && session.visualPosition >= 0,
            intensity: visuals.intensity, motionAllowed: visuals.motionAllowed,
            highQuality: settings.graphics === "high",
            label: section.label, previousLabel: previous,
            sectionAge: current ? session.position - current.start : 2,
            sectionImpact: section.impact, music: visuals.frame, energy,
            features: state.features, hasFeatures: state.hasFeatures,
        });
        state.frame = frame;
        const transform = world.storage(Transform);
        for (const layer of LAYERS) state.counts[layer] = 0;
        const hide = (eid: number) => {
            // Hidden slots must also be deterministic after a seek/retry.
            transform.translation.set(eid, 0, -2, 0);
            transform.rotation.set(eid, 0, 0, 0, 1);
            transform.scale.set(eid, 0, 0, 0);
        };
        if (!frame.enabled) {
            for (const layer of LAYERS) for (const eid of state.entities[layer]) hide(eid);
            state.cpuMs = visuals.profileCpu ? performance.now() - started : 0;
            return;
        }
        const arrangement = frame.arrangement;
        // The motion-reduced variant is a quiet, stationary spectrum border only.
        const response = frame.moving ? frame.energy : 0.22;
        const power = frame.gain * response * (1 - frame.release * 0.35);
        const color = section.palette.accent, peak = Math.max(...color, 0.001);
        const materialStore = world.resource(StageMaterial);
        const gain: Record<Layer, number> = {
            spectrum: arrangement.spectrum * (0.55 + response * 0.9 + frame.accent * 0.55),
            lasers: arrangement.lasers * (2.2 + frame.accent * 1.4),
            aurora: arrangement.aurora * (2.4 + frame.accent * 0.9),
            particles: arrangement.aurora * (2.1 + frame.high * 0.8),
            echoes: arrangement.echoes * 0.24,
            geometry: arrangement.geometry * (0.32 + frame.accent * 0.35),
        };
        for (const layer of LAYERS) {
            const handle = state.materials[layer];
            if (handle) {
                const light = gain[layer] * power;
                const ribbon = layer === "aurora" || layer === "particles";
                const hue = (lane: number) => (ribbon
                    ? color[lane]! * 0.45 + color[(lane + 1) % 3]! * 0.55 : color[lane]!) / peak * light;
                materialStore.update(handle, {
                    color: [hue(0), hue(1), hue(2), 1],
                    softness: ribbon || layer === "lasers" ? 1 : 0,
                });
            }
        }
        const segment = (layer: Layer, index: number, ax: number, az: number, bx: number, bz: number, y: number, width: number) => {
            const eid = state.entities[layer][index];
            if (eid === undefined) return;
            if (width < 0.002 || power < 0.002 || (!frame.moving && layer !== "spectrum")) { hide(eid); return; }
            const dx = bx - ax, dz = bz - az, yaw = Math.atan2(dx, dz);
            transform.translation.set(eid, (ax + bx) / 2, y, (az + bz) / 2);
            transform.rotation.set(eid, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
            transform.scale.set(eid, width, 0.025, Math.max(0.025, Math.hypot(dx, dz)));
            state.counts[layer]++;
        };
        const sides = 16;
        for (let edge = 0; edge < 4; edge++) for (let band = 0; band < sides; band++) {
            const along = (band + 0.5) / sides * 35 - 17.5;
            const spectral = !frame.moving ? 0.18 : state.hasFeatures ? state.features.spectrum[band]!
                : frame.bass * (1 - band / 22) * (0.55 + frame.accent);
            const length = 0.12 + spectral * (2.5 + frame.buildup + frame.accent * 0.8) * arrangement.spectrum;
            const rotation = edge * Math.PI / 2;
            const c = Math.cos(rotation), s = Math.sin(rotation);
            segment("spectrum", edge * sides + band, along * c - 19.3 * s, along * s + 19.3 * c,
                along * c - (19.3 + length) * s, along * s + (19.3 + length) * c,
                -0.48, (band < 5 ? 0.72 : 0.36) * arrangement.spectrum);
        }
        // Four fans point outwards from the corners. Changing target formations
        // is interpolated over the beat, so there is no one-frame laser snap.
        const beatIndex = Math.floor(frame.beat), beatMix = frame.beat - beatIndex;
        const formation = Math.sin(beatIndex * 2.39996) * (1 - beatMix) + Math.sin((beatIndex + 1) * 2.39996) * beatMix;
        const rays = frame.low ? 3 : 6;
        for (let corner = 0; corner < 4; corner++) for (let ray = 0; ray < 6; ray++) {
            const index = corner * 6 + ray;
            if (ray >= rays) { hide(state.entities.lasers[index]!); continue; }
            const angle = Math.PI / 4 + corner * Math.PI / 2;
            const spread = (ray / (rays - 1) - 0.5) * (0.35 + arrangement.lasers * 0.8 + frame.buildup * 0.2);
            const heading = angle + spread + formation * 0.16;
            const ax = Math.cos(angle) * 26.6, az = Math.sin(angle) * 26.6;
            const length = 5 + frame.mid * 8 + frame.accent * 4;
            segment("lasers", index, ax, az, ax + Math.cos(heading) * length, az + Math.sin(heading) * length,
                -1.1, arrangement.lasers * (0.14 + frame.accent * 0.12));
        }
        const steps = frame.low ? 24 : 48;
        for (let lane = 0; lane < 2; lane++) for (let step = 0; step < 48; step++) {
            const index = lane * 48 + step;
            if (step >= steps) { hide(state.entities.aurora[index]!); continue; }
            const angle = step / steps * Math.PI * 2, next = (step + 1) / steps * Math.PI * 2;
            const spread = frame.mid * 1.3 + frame.buildup * 1.2;
            const a = auroraPoint(frame.travel, lane, angle, spread), b = auroraPoint(frame.travel, lane, next, spread);
            const taper = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(angle * 2 - frame.travel * 0.5 + lane)) ** 3;
            segment("aurora", index, ...a, ...b, -2.8 - lane * 0.3,
                arrangement.aurora * taper * (0.65 + frame.mid * 0.7));
        }
        const particles = frame.low ? 16 : 32;
        for (let i = 0; i < 32; i++) {
            if (i >= particles) { hide(state.entities.particles[i]!); continue; }
            const lane = i % 2, angle = i * 2.39996 + frame.travel * (0.14 + lane * 0.025);
            const a = auroraPoint(frame.travel, lane, angle, frame.mid * 1.3 + frame.buildup * 1.2);
            const b = auroraPoint(frame.travel, lane, angle - 0.014 - frame.high * 0.025, frame.mid * 1.3 + frame.buildup * 1.2);
            segment("particles", i, ...a, ...b, -2.65 - lane * 0.3, arrangement.aurora * (0.12 + frame.high * 0.18));
        }
        // Two slowly turning wireframes morph between regular polygons at section
        // changes; three delayed expanding copies form a bounded visual echo.
        for (const layer of ["geometry", "echoes"] as const) {
            const rings = layer === "geometry" ? 2 : 3;
            const visibleRings = frame.low ? 1 : rings;
            for (let ring = 0; ring < rings; ring++) for (let vertex = 0; vertex < 24; vertex++) {
                const index = ring * 24 + vertex;
                if (ring >= visibleRings) { hide(state.entities[layer][index]!); continue; }
                const echo = layer === "echoes";
                const age = echo ? ((frame.beat / 8 + ring / 3) % 1 + 1) % 1 : 0;
                const fade = echo ? smooth(age / 0.15) * (1 - smooth((age - 0.35) / 0.65)) : 1;
                const radius = echo ? 21 + age * 16 : 24 + ring * 4 + frame.opening * 1.5 + frame.accent * 0.55;
                const rotation = (echo ? frame.travel * 0.035 - age * 0.25 : frame.travel * (ring ? -0.025 : 0.025))
                    + ring * Math.PI / 12;
                const point = (corner: number): [number, number] => {
                    const angle = corner / 24 * Math.PI * 2;
                    const before = polygonRadius(angle, frame.fromSides), after = polygonRadius(angle, arrangement.sides);
                    const r = radius * (before + (after - before) * frame.shapeBlend);
                    return [Math.cos(angle + rotation) * r, Math.sin(angle + rotation) * r];
                };
                const a = point(vertex), b = point(vertex + 1);
                segment(layer, index, ...a, ...b, echo ? -2.4 : -2,
                    (echo ? arrangement.echoes * fade * (0.04 + frame.accent * 0.045) : arrangement.geometry * 0.055));
            }
        }
        state.cpuMs = visuals.profileCpu ? performance.now() - started : 0;
    },
};

export const MusicStagePlugin: Plugin = {
    name: "Beatshooter/MusicStage",
    dependencies: [MeshPlugin, StageRegistration],
    initialize(world) {
        const store = world.resource(StageMaterial);
        const soft = (layer: Layer) => layer === "aurora" || layer === "particles" || layer === "lasers";
        const handles = Object.fromEntries(LAYERS.map(layer => [layer, store.add({
            color: [0, 0, 0, 1], softness: soft(layer) ? 1 : 0,
        }, { alphaMode: soft(layer) ? AlphaMode.Blend : AlphaMode.Opaque })])) as Record<Layer, MaterialHandle>;
        createStagePool(world, handles);
        const plane = world.resource(Meshes).add({
            name: "Beatshooter/StageRibbon",
            vertices: new Float32Array([
                -0.5, 0, -0.5, 0, 0, 1, 0, 0,
                 0.5, 0, -0.5, 1, 0, 1, 0, 0,
                 0.5, 0,  0.5, 1, 0, 1, 0, 1,
                -0.5, 0,  0.5, 0, 0, 1, 0, 1,
            ]),
            indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
        });
        const state = world.resource(MusicStage), instances = world.storage(MeshInstance);
        for (const layer of LAYERS) if (soft(layer)) {
            for (const eid of state.entities[layer]) instances.mesh.set(eid, plane);
        }
    },
    systems: [PresentMusicStage],
};
