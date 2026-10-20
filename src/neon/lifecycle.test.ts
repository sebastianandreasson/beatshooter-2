import { expect, test } from "bun:test";
import type { World } from "@dylanebert/shallot";
import { Camera, EffectPasses, type View, Views } from "@dylanebert/shallot/rendering";
import { Neon, NeonPlugin, PrepareNeon } from "./index";
import { sampleNeonFrame } from "./postprocess";

function fixture() {
    const state = Neon.create({} as World);
    state.frame = sampleNeonFrame({
        visible: true, gameplay: true, intensity: "standard", reducedMotion: false, reducedFlash: false,
        highQuality: true, beatPulse: 0, downbeatPulse: 0, musicalStrength: 1,
        sectionActive: false, sectionProgress: 0,
    });
    const effects = EffectPasses.create();
    const view = {
        width: 1920, height: 1080, present: {}, framebuffer: {},
    } as unknown as View;
    const views = new Map([[7, view]]);
    const calls = {
        textures: 0, textureDestroy: 0, buffers: 0, bufferDestroy: 0, groups: 0, passes: 0, scopes: 0, resourceReads: 0,
    };
    const disposers: (() => void)[] = [];
    const device = {
        createBuffer() {
            calls.buffers++;
            return { destroy() { calls.bufferDestroy++; } };
        },
        createTexture() {
            calls.textures++;
            return { createView() { return {}; }, destroy() { calls.textureDestroy++; } };
        },
        createBindGroup() { calls.groups++; return {}; },
        queue: { writeBuffer() {} },
        pushErrorScope() { calls.scopes++; },
        async popErrorScope() { calls.scopes--; return null; },
        createShaderModule() {
            return { async getCompilationInfo() { return { messages: [{ type: "error", message: "fixture shader rejected" }] }; } };
        },
    };
    const world = {
        gpu: { device },
        resource(resource: unknown) {
            calls.resourceReads++;
            if (resource === Neon) return state;
            if (resource === EffectPasses) return effects;
            if (resource === Views) return views;
            throw new Error("Unexpected fixture resource");
        },
        query() { return views.keys(); },
        has(eid: number, component: unknown) { return component === Camera && views.has(eid); },
        onDispose(callback: () => void) { disposers.push(callback); },
        frameEncoder() {
            return {
                beginRenderPass() {
                    calls.passes++;
                    return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
                },
            };
        },
    } as unknown as World;
    return { state, effects, view, views, calls, disposers, world };
}

test("camera targets are reused and bloom stays ahead of existing effects through bypass, resize and disposal", async () => {
    const oldBufferUsage = globalThis.GPUBufferUsage, oldTextureUsage = globalThis.GPUTextureUsage;
    Object.assign(globalThis, {
        GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 },
        GPUTextureUsage: { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 },
    });
    const f = fixture();
    const vignette = () => {}, otherBefore = () => {}, afterToneMapping = () => {};
    f.effects.set(7, { before: [vignette, otherBefore], after: [afterToneMapping] });
    try {
        await NeonPlugin.initialize!(f.world);
        f.state.status = "ready";
        f.state.pipelines = { extract: {}, horizontal: {}, vertical: {}, low: {}, composite: {} } as NonNullable<typeof f.state.pipelines>;
        f.state.layout = {} as GPUBindGroupLayout;
        f.state.sampler = {} as GPUSampler;
        const render = () => {
            PrepareNeon.update!(f.world);
            for (const effect of f.effects.get(7)?.before ?? []) {
                effect(f.world, 7, f.view, f.view.framebuffer!, {} as GPUTextureView);
            }
        };
        render();
        expect(f.state.passes).toBe(4);
        expect(f.calls.textures).toBe(3);
        expect(f.calls.buffers).toBe(1);
        expect(f.calls.groups).toBe(4);
        const effect = f.state.cameras.get(7)!.effect;
        expect(f.effects.get(7)!.before).toEqual([effect, vignette, otherBefore]);
        expect(f.effects.get(7)!.after).toEqual([afterToneMapping]);
        for (let frame = 0; frame < 30; frame++) render();
        expect(f.calls.passes).toBe(31 * 4);
        expect(f.calls.textures).toBe(3);
        expect(f.calls.groups).toBe(4);
        expect(f.effects.get(7)!.before).toEqual([effect, vignette, otherBefore]);
        f.state.frame.enabled = false;
        render();
        expect(f.state.passes).toBe(0);
        expect(f.effects.get(7)!.before).toEqual([vignette, otherBefore]);
        expect(f.effects.get(7)!.after).toEqual([afterToneMapping]);
        expect(f.calls.textureDestroy).toBe(0);
        f.state.frame.enabled = true;
        f.state.frame.reducedDetail = true;
        render();
        expect(f.state.passes).toBe(3);
        expect(f.calls.textureDestroy).toBe(3);
        expect(f.calls.textures).toBe(5);
        expect(f.effects.get(7)!.before).toEqual([effect, vignette, otherBefore]);
        f.view.width = 1024;
        render();
        expect(f.calls.textureDestroy).toBe(5);
        expect(f.calls.textures).toBe(7);
        expect(f.state.dimensions.bloomWidth).toBe(128);
        expect(f.effects.get(7)!.before).toEqual([effect, vignette, otherBefore]);
        f.views.clear();
        PrepareNeon.update!(f.world);
        expect(f.calls.textureDestroy).toBe(7);
        expect(f.calls.bufferDestroy).toBe(1);
        expect(f.state.cameras.size).toBe(0);
        expect(f.effects.get(7)!.before).toEqual([vignette, otherBefore]);
        f.views.set(7, f.view);
        render();
        expect(f.calls.buffers).toBe(2);
        expect(f.effects.get(7)!.before).toEqual([f.state.cameras.get(7)!.effect, vignette, otherBefore]);
        expect(f.effects.get(7)!.after).toEqual([afterToneMapping]);
        const readsBeforeDispose = f.calls.resourceReads;
        for (const dispose of f.disposers) dispose();
        expect(f.calls.resourceReads).toBe(readsBeforeDispose);
        expect(f.calls.textureDestroy).toBe(9);
        expect(f.calls.bufferDestroy).toBe(2);
        expect(f.state.cameras.size).toBe(0);
        expect(f.effects.get(7)!.before).toEqual([vignette, otherBefore]);
        expect(f.effects.get(7)!.after).toEqual([afterToneMapping]);
    } finally {
        if (oldBufferUsage) Object.assign(globalThis, { GPUBufferUsage: oldBufferUsage });
        else Reflect.deleteProperty(globalThis, "GPUBufferUsage");
        if (oldTextureUsage) Object.assign(globalThis, { GPUTextureUsage: oldTextureUsage });
        else Reflect.deleteProperty(globalThis, "GPUTextureUsage");
    }
});

test("shader validation failure balances its scope and leaves the original presentation stack intact", async () => {
    const f = fixture();
    const otherEffect = () => {};
    f.effects.set(7, { before: [otherEffect], after: [] });
    await NeonPlugin.warm!(f.world);
    expect(f.state.status).toBe("fallback");
    expect(f.state.error).toContain("fixture shader rejected");
    expect(f.calls.scopes).toBe(0);
    PrepareNeon.update!(f.world);
    expect(f.state.passes).toBe(0);
    expect(f.calls.textures).toBe(0);
    expect(f.effects.get(7)!.before).toEqual([otherEffect]);
});
