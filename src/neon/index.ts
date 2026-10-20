import { type Plugin, type Resource, type System, type World } from "@dylanebert/shallot";
import {
    BeginFrameSystem, Camera, CorePipelinePlugin, type EffectPass, EffectPasses, TonemappingSystem, type View, Views,
} from "@dylanebert/shallot/rendering";
import {
    beginRenderPass, draw, endRenderPass, setRenderBindGroup, setRenderPipeline,
} from "@dylanebert/shallot/runtime";
import { Vignette, VignettePlugin } from "@dylanebert/shallot/vignette";
import { Arena } from "../arena";
import { MusicVisuals } from "../music-visuals";
import { SampleSectionEffects } from "../section-effects";
import { SectionEffects } from "../section-effects/runtime";
import { isArenaPhase, Session } from "../session";
import {
    isNeonGameplay, neonShaderSource, neonTargetDimensions, sampleNeonFrame, type NeonDimensions, type NeonFrame,
} from "./postprocess";

interface Target { texture: GPUTexture; view: GPUTextureView }
type PipelineName = "extract" | "horizontal" | "vertical" | "low" | "composite";
interface CameraEffect {
    effect: EffectPass;
    dimensions: NeonDimensions;
    reducedDetail: boolean;
    buffer: GPUBuffer;
    bytes: Float32Array;
    targets: Target[];
    horizontal?: GPUBindGroup;
    vertical?: GPUBindGroup;
    inputs: WeakMap<GPUTextureView, { extract: GPUBindGroup; composite: GPUBindGroup }>;
    pass: GPURenderPassDescriptor;
}

const emptyDimensions = (): NeonDimensions => ({ width: 0, height: 0, bloomWidth: 0, bloomHeight: 0 });

export const Neon: Resource<{
    status: "pending" | "ready" | "fallback";
    error?: string;
    frame: NeonFrame;
    passes: number;
    dimensions: NeonDimensions;
    vignetteCamera?: number;
    cameras: Map<number, CameraEffect>;
    pipelines?: Record<PipelineName, GPURenderPipeline>;
    layout?: GPUBindGroupLayout;
    sampler?: GPUSampler;
}> = {
    create: () => ({
        status: "pending",
        frame: sampleNeonFrame({
            visible: false, gameplay: false, intensity: "off", reducedMotion: false, reducedFlash: false,
            highQuality: true, beatPulse: 0, downbeatPulse: 0, musicalStrength: 0,
            sectionActive: false, sectionProgress: 0,
        }),
        passes: 0, dimensions: emptyDimensions(), cameras: new Map(),
    }),
};
type NeonState = ReturnType<typeof Neon.create>;

export const SampleNeon: System = {
    name: "Beatshooter/SampleNeon", group: "setup", after: [SampleSectionEffects],
    update(world) {
        const session = world.resource(Session), visuals = world.resource(MusicVisuals);
        const section = world.resource(SectionEffects), settings = session.preferences.settings;
        world.resource(Neon).frame = sampleNeonFrame({
            visible: isArenaPhase(session.phase),
            gameplay: isNeonGameplay(session.phase, session.position, session.track.duration),
            intensity: settings.effectsIntensity,
            reducedMotion: visuals.osReducedMotion,
            reducedFlash: settings.reducedFlash,
            highQuality: settings.graphics === "high",
            beatPulse: visuals.frame.beatPulse,
            downbeatPulse: visuals.frame.downbeatPulse,
            musicalStrength: visuals.frame.strength,
            sectionActive: section.frame.active && section.frame.musical,
            sectionProgress: section.frame.progress,
        });
    },
};

/** Native camera effect; zero intensity detaches its GPU pass while menus are open. */
export const ApplyNeonVignette: System = {
    name: "Beatshooter/ApplyNeonVignette", group: "setup", after: [SampleNeon],
    update(world) {
        const state = world.resource(Neon), camera = world.resource(Arena).camera;
        if (state.vignetteCamera !== undefined && state.vignetteCamera !== camera
            && world.has(state.vignetteCamera, Vignette)) {
            world.remove(state.vignetteCamera, Vignette);
        }
        if (!world.has(camera, Vignette)) {
            world.add(camera, Vignette, {
                intensity: 0, radius: 0.8, smoothness: 1, roundness: 1,
                center: [0.5, 0.5], edgeCompensation: 1, color: 0,
            });
        }
        state.vignetteCamera = camera;
        world.storage(Vignette).intensity.set(camera, state.frame.vignette);
    },
};

function removeEffect(world: World, eid: number, camera: CameraEffect): void {
    detachEffect(world.resource(EffectPasses), eid, camera);
}

function detachEffect(effects: ReturnType<typeof EffectPasses.create>, eid: number, camera: CameraEffect): void {
    const stack = effects.get(eid);
    const index = stack?.before.indexOf(camera.effect) ?? -1;
    if (index >= 0) stack!.before.splice(index, 1);
}

function destroyTargets(camera: CameraEffect): void {
    for (const target of camera.targets) target.texture.destroy();
    camera.targets.length = 0;
    camera.inputs = new WeakMap();
    camera.horizontal = undefined;
    camera.vertical = undefined;
}

function destroyCamera(camera: CameraEffect): void {
    destroyTargets(camera);
    camera.buffer.destroy();
}

function target(world: World, width: number, height: number, label: string): Target {
    const texture = world.gpu.device.createTexture({
        label, size: [width, height], format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return { texture, view: texture.createView() };
}

function group(world: World, state: NeonState, camera: CameraEffect, input: GPUTextureView, halo: GPUTextureView): GPUBindGroup {
    return world.gpu.device.createBindGroup({
        layout: state.layout!,
        entries: [
            { binding: 0, resource: input },
            { binding: 1, resource: halo },
            { binding: 2, resource: state.sampler! },
            { binding: 3, resource: { buffer: camera.buffer } },
        ],
    });
}

function prepareTargets(world: World, state: NeonState, camera: CameraEffect, view: View): void {
    const reducedDetail = state.frame.reducedDetail;
    if (camera.targets.length && camera.dimensions.width === view.width &&
        camera.dimensions.height === view.height && camera.reducedDetail === reducedDetail) return;
    destroyTargets(camera);
    const dimensions = neonTargetDimensions(view.width, view.height, reducedDetail);
    camera.dimensions = dimensions;
    camera.reducedDetail = reducedDetail;
    camera.targets.push(target(world, dimensions.extractWidth, dimensions.extractHeight, "Neon/highlights"));
    camera.targets.push(target(world, dimensions.bloomWidth, dimensions.bloomHeight, "Neon/blur-horizontal"));
    if (!reducedDetail) camera.targets.push(target(world, dimensions.bloomWidth, dimensions.bloomHeight, "Neon/blur-vertical"));
    camera.horizontal = group(world, state, camera, camera.targets[0]!.view, camera.targets[0]!.view);
    if (!reducedDetail) camera.vertical = group(world, state, camera, camera.targets[1]!.view, camera.targets[1]!.view);
}

function recordPass(
    world: World, camera: CameraEffect, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, output: GPUTextureView,
): void {
    (camera.pass.colorAttachments as GPURenderPassColorAttachment[])[0]!.view = output;
    const pass = beginRenderPass(world.frameEncoder()!, camera.pass);
    setRenderPipeline(pass, pipeline);
    setRenderBindGroup(pass, 0, bindGroup);
    draw(pass, 3);
    endRenderPass(pass);
}

function createCamera(world: World, state: NeonState): CameraEffect {
    const camera: CameraEffect = {
        buffer: world.gpu.device.createBuffer({
            label: "Neon/settings", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        bytes: new Float32Array(8), dimensions: emptyDimensions(), reducedDetail: false,
        targets: [], inputs: new WeakMap(),
        pass: { label: "Neon", colorAttachments: [{ view: null!, loadOp: "clear", storeOp: "store" }] },
        effect: (w, _eid, _view, input, output) => {
            let cached = camera.inputs.get(input);
            if (!cached) {
                cached = {
                    extract: group(w, state, camera, input, input),
                    composite: group(w, state, camera, input, camera.targets.at(-1)!.view),
                };
                camera.inputs.set(input, cached);
            }
            const pipelines = state.pipelines!;
            recordPass(w, camera, pipelines.extract, cached.extract, camera.targets[0]!.view);
            recordPass(w, camera, camera.reducedDetail ? pipelines.low : pipelines.horizontal,
                camera.horizontal!, camera.targets[1]!.view);
            if (!camera.reducedDetail) recordPass(w, camera, pipelines.vertical, camera.vertical!, camera.targets[2]!.view);
            recordPass(w, camera, pipelines.composite, cached.composite, output);
        },
    };
    return camera;
}

export const PrepareNeon: System = {
    name: "Beatshooter/PrepareNeon", group: "draw", after: [BeginFrameSystem], before: [TonemappingSystem],
    update(world) {
        const state = world.resource(Neon), views = world.resource(Views), effects = world.resource(EffectPasses);
        state.passes = 0;
        for (const [eid, camera] of state.cameras) {
            if (world.has(eid, Camera) && views.has(eid)) continue;
            removeEffect(world, eid, camera);
            destroyCamera(camera);
            state.cameras.delete(eid);
        }
        if (state.status !== "ready" || !state.frame.enabled) {
            for (const [eid, camera] of state.cameras) removeEffect(world, eid, camera);
            return;
        }
        try {
            for (const eid of world.query([Camera])) {
                const view = views.get(eid);
                if (!view?.present || !view.framebuffer) continue;
                let camera = state.cameras.get(eid);
                if (!camera) {
                    camera = createCamera(world, state);
                    state.cameras.set(eid, camera);
                }
                prepareTargets(world, state, camera, view);
                const frame = state.frame, bytes = camera.bytes;
                bytes[0] = frame.bloom; bytes[1] = frame.threshold;
                bytes[2] = frame.knee; bytes[3] = frame.chromatic;
                bytes[4] = 0; bytes[5] = view.width;
                bytes[6] = view.height; bytes[7] = frame.reducedDetail ? 1 : 0;
                world.gpu.device.queue.writeBuffer(camera.buffer, 0, bytes);
                let stack = effects.get(eid);
                if (!stack) {
                    stack = { before: [], after: [] };
                    effects.set(eid, stack);
                }
                // Bloom precedes native finishing effects even after either pass is re-enabled.
                if (!stack.before.includes(camera.effect)) stack.before.unshift(camera.effect);
                state.passes = frame.reducedDetail ? 3 : 4;
                state.dimensions = camera.dimensions;
            }
        } catch (error) {
            state.status = "fallback";
            state.error = error instanceof Error ? error.message : String(error);
            state.passes = 0;
            for (const [eid, camera] of state.cameras) removeEffect(world, eid, camera);
        }
    },
};

async function initializePipelines(world: World): Promise<void> {
    const state = world.resource(Neon), device = world.gpu.device;
    device.pushErrorScope("validation");
    let failure: unknown;
    try {
        const module = device.createShaderModule({ label: "Neon/HDR bloom", code: neonShaderSource() });
        const compilation = await module.getCompilationInfo();
        const errors = compilation.messages.filter(message => message.type === "error");
        if (errors.length) throw new Error(errors.map(message => message.message).join("\n"));
        state.layout = device.createBindGroupLayout({
            label: "Neon/layout", entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        state.sampler = device.createSampler({
            label: "Neon/linear", minFilter: "linear", magFilter: "linear",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
        });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [state.layout] });
        const pipelines = {} as Record<PipelineName, GPURenderPipeline>;
        for (const [name, entryPoint] of [
            ["extract", "neonExtract"], ["horizontal", "neonHorizontal"], ["vertical", "neonVertical"],
            ["low", "neonLowBlur"], ["composite", "neonComposite"],
        ] as const) {
            pipelines[name] = await device.createRenderPipelineAsync({
                label: `Neon/${name}`, layout,
                vertex: { module, entryPoint: "neonVertex" },
                fragment: { module, entryPoint, targets: [{ format: "rgba16float" }] },
                primitive: { topology: "triangle-list" },
            });
        }
        state.pipelines = pipelines;
    } catch (error) { failure = error; }
    const validation = await device.popErrorScope();
    if (failure || validation) {
        state.status = "fallback";
        state.error = failure instanceof Error ? failure.message : failure ? String(failure) : validation!.message;
        state.pipelines = undefined;
        return;
    }
    state.status = "ready";
}

export const NeonPlugin: Plugin = {
    name: "Beatshooter/Neon",
    gpu: {},
    dependencies: [CorePipelinePlugin, VignettePlugin],
    initialize(world) {
        const state = world.resource(Neon), effects = world.resource(EffectPasses);
        world.onDispose(() => {
            for (const [eid, camera] of state.cameras) {
                detachEffect(effects, eid, camera);
                destroyCamera(camera);
            }
            state.cameras.clear();
            state.pipelines = undefined;
            state.layout = undefined;
            state.sampler = undefined;
            state.passes = 0;
            state.dimensions = emptyDimensions();
        });
    },
    warm: initializePipelines,
    systems: [SampleNeon, ApplyNeonVignette, PrepareNeon],
};
