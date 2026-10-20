import { expect, test } from "bun:test";
import {
    Body, ClearChangeMarksSystem, createApp, Materials, MeshInstance, MeshMaterial,
    StandardMaterial, Transform,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import {
    AlphaMode, MaterialPlugin, MaterialTypes, materialType, materialTypeId,
    type MaterialHandle,
} from "@dylanebert/shallot/standard/rendering";
import tgpu from "typegpu";
import * as d from "typegpu/data";
import { NO_SECTION_FRAME, SectionEffects } from "../section-effects/runtime";
import { Starfield } from "../starfield";
import { RouteShockwave, SampleShockwave, Shockwave, ShockwaveMaterial, ShockwaveRegistration } from "./index";

test("the actual material vertex and PBR fragment resolve with value copies rather than invalid reference assignments", () => {
    expect(() => tgpu.resolve({
        externals: { deform: ShockwaveMaterial.vertex!, shade: ShockwaveMaterial.fragment },
        template: "// Resolve the registered shaders: deform shade",
    })).not.toThrow();
});

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app, materials = world.resource(Materials);
    await ShockwaveRegistration.initialize!(world);
    const ordinary = materials.add(StandardMaterial({ baseColor: [0.2, 0.7, 0.8, 1], metallic: 0.2 }));
    const transparent = materials.add(StandardMaterial({ baseColor: [0.6, 0.2, 0.8, 0.4], unlit: true }), {
        alphaMode: AlphaMode.Blend,
    });
    const mesh = (handle: MaterialHandle, scale: [number, number, number] = [1, 1, 1]) => {
        const eid = world.create();
        world.add(eid, Transform, { translation: [8, 0.55, -10], scale });
        world.add(eid, MeshInstance, { cullBounds: [0, 0, 0, 1] });
        world.add(eid, MeshMaterial, handle);
        return eid;
    };
    return { app, world, materials, ordinary, transparent, mesh, state: world.resource(Shockwave) };
}

test("routing borrows original material rows and preserves physics, live tints, transparency and late spawns", async () => {
    const f = await fixture();
    try {
        const { world, materials, ordinary, transparent, mesh, state } = f;
        const actor = mesh(ordinary), beam = mesh(transparent), star = mesh(ordinary);
        world.resource(Starfield).stars.push(star);
        world.add(actor, Body);
        world.add(actor, Shape);
        const transform = world.get(actor, Transform), body = world.get(actor, Body), shape = world.get(actor, Shape);
        const before = world.get(beam, MeshMaterial)!;
        RouteShockwave.update!(world);
        const type = materialTypeId(world, ShockwaveMaterial);
        expect(world.resource(MaterialTypes).sources[type]).toBe(materials);
        expect(world.get(actor, MeshMaterial)).toEqual({ ...ordinary, type });
        expect(world.get(beam, MeshMaterial)).toEqual({ ...before, type });
        expect(world.get(star, MeshMaterial)).toEqual(ordinary);
        expect(state.affectedCount).toBe(2);
        expect(world.get(actor, Transform)).toEqual(transform);
        expect(world.get(actor, Body)).toEqual(body);
        expect(world.get(actor, Shape)).toEqual(shape);
        materials.update(ordinary, { baseColor: [0.95, 0.2, 0.12, 1] });
        expect(materials.get(ordinary)!.baseColor.x).toBeCloseTo(0.95);
        // Combat swaps just the source row; the alias continues to see it.
        world.storage(MeshMaterial).material.set(actor, transparent.material);
        const late = mesh(ordinary);
        RouteShockwave.update!(world);
        expect(world.get(actor, MeshMaterial)!.material).toBe(transparent.material);
        expect(world.get(late, MeshMaterial)!.type).toBe(type);
        expect(state.affectedCount).toBe(3);
        expect(ShockwaveMaterial.depthPass).toEqual({ prepass: true, shadows: true });
        expect(RouteShockwave.before).toContain(ClearChangeMarksSystem);
    } finally { f.app.dispose(); }
});

test("bounds cover maximum world lift at changing scales without accumulating padding or losing owner edits", async () => {
    const f = await fixture();
    try {
        const { world, ordinary, mesh, state } = f;
        const eid = mesh(ordinary, [2, 0.5, 1]);
        const bounds = world.storage(MeshInstance).cullBounds;
        RouteShockwave.update!(world);
        expect(bounds.w.get(eid)).toBeCloseTo(1.75);
        const cache = state.bounds.get(eid), original = cache!.original, applied = cache!.applied;
        for (let frame = 0; frame < 30; frame++) RouteShockwave.update!(world);
        expect(bounds.w.get(eid)).toBeCloseTo(1.75);
        expect(state.bounds.get(eid)).toBe(cache);
        expect(cache!.original).toBe(original);
        expect(cache!.applied).toBe(applied);
        world.storage(Transform).scale.set(eid, -0.5, 0.25, 0.1);
        RouteShockwave.update!(world);
        expect(bounds.w.get(eid)).toBeCloseTo(4);
        bounds.set(eid, 0.2, 0.3, 0.4, 5);
        RouteShockwave.update!(world);
        expect(bounds.w.get(eid)).toBeCloseTo(8);
        expect(bounds.x.get(eid)).toBeCloseTo(0.2);
        world.resource(Starfield).stars.push(eid);
        RouteShockwave.update!(world);
        expect(bounds.w.get(eid)).toBe(5);
        expect(world.get(eid, MeshMaterial)).toEqual(ordinary);
        expect(state.bounds.size).toBe(0);
    } finally { f.app.dispose(); }
});

test("custom materials retain their shader and bounds, and dropped mesh ownership releases the cache", async () => {
    const f = await fixture();
    try {
        const { world, ordinary, mesh, state } = f;
        const CustomParameters = d.struct({ color: d.vec4f });
        const custom = materialType({
            name: "ShockwaveTest/TextOrFloor", parameters: CustomParameters,
            defaults: { color: d.vec4f(1) },
            fragment: ctx => { "use gpu"; return ctx.parameters.color; },
        });
        await MaterialPlugin(custom).initialize!(world);
        const eid = mesh(world.resource(custom).add({ color: d.vec4f(1) }));
        const before = world.get(eid, MeshMaterial);
        RouteShockwave.update!(world);
        expect(world.get(eid, MeshMaterial)).toEqual(before);
        expect(world.storage(MeshInstance).cullBounds.w.get(eid)).toBe(1);
        expect(state.affectedCount).toBe(0);
        const actor = mesh(ordinary);
        RouteShockwave.update!(world);
        expect(state.bounds.size).toBe(1);
        world.remove(actor, MeshInstance);
        RouteShockwave.update!(world);
        expect(state.bounds.size).toBe(0);
    } finally { f.app.dispose(); }
});

test("the shared uniform follows absolute section progress and suppresses gaps, menus and comfort-disabled waves", async () => {
    const f = await fixture();
    try {
        const { world, state } = f, section = world.resource(SectionEffects);
        section.frame = { ...NO_SECTION_FRAME, active: true, musical: true, progress: 0.35 };
        section.motionAllowed = true; section.strength = 0.85;
        SampleShockwave.update!(world);
        expect(state.progress).toBe(0.35);
        expect(state.strength).toBe(0.85);
        for (let frame = 0; frame < 20; frame++) SampleShockwave.update!(world);
        expect(state.progress).toBe(0.35);
        section.strength = 0.22;
        SampleShockwave.update!(world);
        expect(state.strength).toBe(0.22);
        section.motionAllowed = false;
        SampleShockwave.update!(world);
        expect(state.strength).toBe(0);
        section.motionAllowed = true; section.frame.musical = false;
        SampleShockwave.update!(world);
        expect(state.strength).toBe(0);
        section.frame = NO_SECTION_FRAME;
        SampleShockwave.update!(world);
        expect(state.progress).toBe(NO_SECTION_FRAME.progress);
        expect(state.strength).toBe(0);
    } finally { f.app.dispose(); }
});
