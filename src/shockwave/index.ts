import {
    ClearChangeMarksSystem, Materials, Meshes, MeshInstance, MeshMaterial, StandardMaterial, Transform,
    type Plugin, type Resource, type System, type Vector4Field, type World,
} from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { ImageBindings, sampleImage } from "@dylanebert/shallot/rendering";
import {
    AlphaModeCode, applyPbrLighting, materialLayout, MaterialPlugin, materialType, materialTypeId,
    pbrInputFromMaterial, StandardMaterialInput,
} from "@dylanebert/shallot/standard/rendering";
import type { TgpuBuffer, UniformFlag } from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";
import { SampleSectionEffects } from "../section-effects";
import { SectionEffects } from "../section-effects/runtime";
import { Starfield } from "../starfield";
import { Arena, ArenaPlugin } from "../arena";
import { boxEdgeCoordinate, neonEdgeEmission } from "../neon/edges";
import { SHOCKWAVE_MAX_LIFT, shockwaveSurface } from "./surface";

export const ShockwaveUniform = d.struct({
    progress: d.f32, strength: d.f32, padding: d.vec2f, outlineRows: d.vec4u,
});
type Bounds = [number, number, number, number];
interface BoundOverride { original: Bounds; applied: Bounds; seen: number }

export const Shockwave: Resource<{
    progress: number;
    strength: number;
    affectedCount: number;
    status: "pending" | "ready" | "disposed";
    buffer?: TgpuBuffer<typeof ShockwaveUniform> & UniformFlag;
    bounds: Map<number, BoundOverride>;
    stars: Set<number>;
    epoch: number;
    scratch: Bounds;
    outlineRows: d.v4u;
}> = {
    create: () => ({
        progress: 0, strength: 0, affectedCount: 0, status: "pending", bounds: new Map(),
        stars: new Set(), epoch: 0, scratch: [0, 0, 0, 0],
        outlineRows: d.vec4u(0xffffffff),
    }),
};

const layout = materialLayout(StandardMaterialInput, {
    wave: { type: "uniform", struct: ShockwaveUniform },
    images: { type: "texture-2d-array" },
    imageSampler: { type: "sampler" },
    imageSettings: { type: "texture-2d" },
});

/**
 * A vertex-deformed view of the original live material table. Gameplay still owns
 * the same rows, including hit tints, particle alpha and subsequent color edits.
 */
export const ShockwaveMaterial = materialType({
    name: "Beatshooter/Shockwave",
    layout,
    source: Materials,
    defaults: StandardMaterial(),
    bindings: world => ({ ...world.resource(ImageBindings), wave: world.resource(Shockwave).buffer! }),
    fragmentInputs: { uv: true, localPos: true },
    depthPass: { prepass: true, shadows: true },
    vertex: input => {
        "use gpu";
        const wave = layout.$.wave;
        const surface = shockwaveSurface(wave.progress, wave.strength, input.world.xyz, input.worldNormal);
        return { world: d.vec4f(surface.position, input.world.w), worldNormal: surface.normal };
    },
    fragment: ctx => {
        "use gpu";
        const material = ctx.parameters;
        let color = d.vec4f(material.baseColor);
        const dx = std.dpdx(ctx.uv);
        const dy = std.dpdy(ctx.uv);
        if (material.baseColorTexture >= 0) {
            color = std.mul(color, sampleImage(
                layout.$.images, layout.$.imageSampler, layout.$.imageSettings,
                ctx.uv, material.baseColorTexture, dx, dy,
            ));
        }
        const alphaWidth = std.fwidth(color.a);
        const edgeCoordinate = boxEdgeCoordinate(ctx.localPos);
        const edgeFootprint = std.fwidth(edgeCoordinate);
        if (material.baseColorTexture >= 0 && ctx.alphaMode === AlphaModeCode.AlphaToCoverage) {
            color.a = (color.a - ctx.alphaCutoff) / std.max(alphaWidth, 0.0001) + 0.5;
        }
        const surface = pbrInputFromMaterial(ctx);
        surface.baseColor = d.vec4f(color);
        surface.metallic = material.metallic;
        surface.perceptualRoughness = material.perceptualRoughness;
        surface.occlusion = material.occlusion;
        surface.emissive = d.vec3f(material.emissive);
        const rows = layout.$.wave.outlineRows;
        if (ctx.material === rows.x || ctx.material === rows.y || ctx.material === rows.z || ctx.material === rows.w) {
            surface.emissive = neonEdgeEmission(edgeCoordinate, edgeFootprint, material.emissive);
        }
        surface.unlit = material.unlit;
        return applyPbrLighting(surface);
    },
});

export const ShockwaveRegistration = MaterialPlugin(ShockwaveMaterial);

export const SampleShockwave: System = {
    name: "Beatshooter/SampleShockwave", group: "setup", after: [SampleSectionEffects],
    update(world) {
        const section = world.resource(SectionEffects), state = world.resource(Shockwave);
        state.progress = section.frame.progress;
        state.strength = section.frame.active && section.frame.musical && section.motionAllowed ? section.strength : 0;
        state.buffer?.write({
            progress: state.progress, strength: state.strength, padding: d.vec2f(0), outlineRows: state.outlineRows,
        });
    },
};

function sameBounds(a: ArrayLike<number>, b: Bounds): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
function copyBounds(value: ArrayLike<number>): Bounds {
    return [value[0]!, value[1]!, value[2]!, value[3]!];
}
function readBounds(field: Vector4Field, eid: number, out: Bounds): Bounds {
    out[0] = field.x.get(eid); out[1] = field.y.get(eid);
    out[2] = field.z.get(eid); out[3] = field.w.get(eid);
    return out;
}

/** Expand only renderer bounds, relative to the owner's original sphere; never accumulate padding. */
function padBounds(world: World, eid: number): void {
    const state = world.resource(Shockwave), instances = world.storage(MeshInstance);
    const mesh = instances.mesh.get(eid) as MeshHandle;
    const current = readBounds(instances.cullBounds, eid, state.scratch);
    let saved = state.bounds.get(eid);
    if (!saved) {
        saved = { original: copyBounds(current), applied: copyBounds(current), seen: state.epoch };
        state.bounds.set(eid, saved);
    } else if (!sameBounds(current, saved.applied)) {
        for (let lane = 0; lane < 4; lane++) saved.original[lane] = current[lane]!;
    }
    saved.seen = state.epoch;
    const base = saved.original[3] < 0 ? world.resource(Meshes).get(mesh)?.bounds : saved.original;
    if (!base || !world.has(eid, Transform)) return;
    const scale = world.storage(Transform).scale;
    const maxScale = Math.max(Math.abs(scale.x.get(eid)), Math.abs(scale.y.get(eid)), Math.abs(scale.z.get(eid)));
    if (!(maxScale > 0)) return;
    const radius = Math.fround(base[3]! + SHOCKWAVE_MAX_LIFT / maxScale);
    if (current[0] !== base[0] || current[1] !== base[1] || current[2] !== base[2] || current[3] !== radius) {
        instances.cullBounds.set(eid, base[0]!, base[1]!, base[2]!, radius);
    }
    readBounds(instances.cullBounds, eid, saved.applied);
}

export const RouteShockwave: System = {
    name: "Beatshooter/RouteShockwave", group: "draw", first: true, before: [ClearChangeMarksSystem],
    update(world) {
        const state = world.resource(Shockwave), materials = world.storage(MeshMaterial);
        const standard = materialTypeId(world, Materials), deformed = materialTypeId(world, ShockwaveMaterial);
        const stars = state.stars;
        stars.clear();
        for (const eid of world.resource(Starfield).stars) stars.add(eid);
        state.epoch++;
        state.affectedCount = 0;
        for (const eid of world.query([MeshInstance, MeshMaterial])) {
            const type = materials.type.get(eid);
            if (stars.has(eid)) {
                if (type === deformed) materials.type.set(eid, standard);
                continue;
            }
            // Custom text and the independently shaded floor retain their owners.
            if (type !== standard && type !== deformed) continue;
            if (type !== deformed) materials.type.set(eid, deformed);
            padBounds(world, eid);
            state.affectedCount++;
        }
        // Removing a mesh or changing material ownership releases our override.
        for (const [eid, saved] of state.bounds) {
            if (saved.seen === state.epoch) continue;
            if (world.has(eid, MeshInstance)) {
                const instances = world.storage(MeshInstance);
                if (sameBounds(readBounds(instances.cullBounds, eid, state.scratch), saved.applied)) {
                    instances.cullBounds.set(eid, ...saved.original);
                }
            }
            state.bounds.delete(eid);
        }
    },
};

export const ShockwavePlugin: Plugin = {
    name: "Beatshooter/Shockwave",
    dependencies: [ArenaPlugin],
    gpu: {},
    initialize(world) {
        const state = world.resource(Shockwave);
        const materials = world.resource(Arena).materials;
        state.outlineRows = d.vec4u(
            materials.player.material, materials.enemy.material, materials.spinner.material, materials.ranger.material,
        );
        state.buffer = world.gpu.root.createBuffer(ShockwaveUniform, {
            progress: 0, strength: 0, padding: d.vec2f(0), outlineRows: state.outlineRows,
        }).$usage("uniform");
        ShockwaveRegistration.initialize!(world);
        state.status = "ready";
        world.onDispose(() => {
            state.buffer?.destroy();
            state.buffer = undefined;
            state.bounds.clear();
            state.stars.clear();
            state.status = "disposed";
        });
    },
    systems: [SampleShockwave, RouteShockwave],
};
