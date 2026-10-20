import { Materials, MeshInstance, MeshMaterial, type Plugin, type Resource, type World } from "@dylanebert/shallot";
import { MaterialPlugin, materialType, type MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import tgpu from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";
import { Arena, ArenaPlugin } from "../arena";
import { shockwaveSurface } from "../shockwave/surface";

/** Every clock value comes from the transport/chart sampler, never the renderer clock. */
export interface MusicFloorInput {
    beatCoordinate: number;
    beatPhase: number;
    barCoordinate: number;
    barPhase: number;
    beatPulse: number;
    downbeatPulse: number;
    intensity: number;
    energy: number;
    bass: number;
    playerX: number;
    playerZ: number;
    motionAllowed: boolean;
    highQuality: boolean;
    /** Absolute section progress and its persistent palette, independent of beat pulses. */
    section?: {
        progress: number;
        strength: number;
        /** Bounded center charge before the boundary and through its first beat. */
        charge?: number;
        floor: [number, number, number];
        line: [number, number, number];
        accent: [number, number, number];
        from?: {
            floor: [number, number, number];
            line: [number, number, number];
            accent: [number, number, number];
        };
    };
}

const IDLE_INPUT: Readonly<MusicFloorInput> = Object.freeze({
    beatCoordinate: 0, beatPhase: 0, barCoordinate: 0, barPhase: 0,
    beatPulse: 0, downbeatPulse: 0, intensity: 0, energy: 0, bass: 0,
    playerX: 0, playerZ: 0, motionAllowed: false, highQuality: true,
});

/** Fixed-size rows keep uploads small and do not allocate GPU resources on a beat. */
const FloorParameters = d.struct({
    clock: d.vec4f,
    pulse: d.vec4f,
    response: d.vec4f,
    player: d.vec2f,
    section: d.vec4f,
    floorColor: d.vec4f,
    lineColor: d.vec4f,
    accentColor: d.vec4f,
    fromFloor: d.vec4f,
    fromLine: d.vec4f,
    fromAccent: d.vec4f,
});

/** One outward front: x paints the new palette, y lights and refracts only its edge. */
export const sectionShockwave = tgpu.fn([d.f32, d.f32, d.f32, d.f32], d.vec2f)((progress, strength, distance, footprint) => {
    "use gpu";
    if (strength <= 0) return d.vec2f(1, 0);
    const signedDistance = progress * 30 - distance;
    const paint = std.smoothstep(-0.75, 0.75, signedDistance);
    const front = 1 - std.smoothstep(0.3, 1.8 + footprint, std.abs(signedDistance));
    const envelope = std.smoothstep(0, 0.06, progress) * (1 - std.smoothstep(0.88, 1, progress));
    return d.vec2f(paint, front * envelope * strength);
});

/** A fixed soft pool of light, never another ring or moving front. */
export const sectionCharge = tgpu.fn([d.f32, d.f32], d.f32)((charge, distance) => {
    "use gpu";
    const core = 1 - std.smoothstep(0, 4.8, std.max(0, distance));
    return std.clamp(charge, 0, 1) * core * core;
});

const gridLine = tgpu.fn([d.vec2f, d.f32, d.f32], d.f32)((point, width, footprint) => {
    "use gpu";
    const cell = std.abs(std.sub(std.fract(std.add(std.div(point, 3), 0.5)), 0.5));
    const distance = std.min(cell.x, cell.y) * 3;
    return 1 - std.smoothstep(width, width + footprint, distance);
});

/**
 * World-XZ color sampling stays attached as the shared vertex wave lifts the floor.
 * A single outward front paints the next palette over the unchanged play plane.
 */
const shadeFloor = tgpu.fn([FloorParameters, d.vec2f], d.vec4f)((p, point) => {
    "use gpu";
    const footprint = std.max(std.max(std.fwidth(point.x), std.fwidth(point.y)), 0.012);
    const distance = std.length(point);
    const wave = sectionShockwave(p.section.x, p.section.y * p.pulse.w, distance, footprint);
    const ordinaryRings = d.f32(p.section.y > 0 || p.section.w > 0 ? 0 : 1);
    // Optional refraction bends only the grid at the passing front, never geometry.
    const radial = std.div(point, std.max(distance, 0.001));
    const gridPoint = std.add(point, std.mul(radial, wave.y * 0.55 * p.response.z));
    const baseGrid = gridLine(gridPoint, 0.016, footprint);
    const active = p.pulse.z * p.pulse.w;
    const beat = p.clock.x * p.pulse.w;
    const bar = p.clock.z * p.pulse.w;
    const phase = p.clock.w;
    const quiet = std.smoothstep(1.4, 5.5, std.length(std.sub(point, p.player)));
    const edge = std.max(std.abs(point.x), std.abs(point.y));
    const inside = 1 - std.smoothstep(17.8, 18.5, edge);
    const slow = std.sin(bar * 0.78539816339) * active;
    const targetAccent = d.vec3f(
        p.accentColor.x + slow * 0.009 * (1 - p.section.z),
        p.accentColor.y,
        p.accentColor.z - slow * 0.022 * (1 - p.section.z),
    );
    const palette = std.mix(d.vec3f(p.fromAccent.x, p.fromAccent.y, p.fromAccent.z), targetAccent, wave.x);
    const base = std.mix(d.vec3f(p.fromFloor.x, p.fromFloor.y, p.fromFloor.z),
        d.vec3f(p.floorColor.x, p.floorColor.y, p.floorColor.z), wave.x);
    const staticLines = std.mix(d.vec3f(p.fromLine.x, p.fromLine.y, p.fromLine.z),
        d.vec3f(p.lineColor.x, p.lineColor.y, p.lineColor.z), wave.x);
    const pulse = p.pulse.x * (0.045 + p.response.y * 0.045);
    let color = std.add(base, std.mul(staticLines, baseGrid));
    color = std.add(color, std.mul(palette, baseGrid * pulse * active * quiet));

    // One low-frequency diagonal light band travels one full period per four beats.
    const bandPhase = (point.x + point.y) * 0.16 - beat * 1.57079632679;
    const broadBand = std.pow(0.5 + 0.5 * std.sin(bandPhase), 3);
    color = std.add(color, std.mul(palette, broadBand * (0.045 + p.response.x * 0.035)
        * (0.6 + p.pulse.x * 0.9) * active * quiet));

    // The ring traverses the arena over the current actual bar, then fades before resetting.
    const radius = phase * 27;
    const ringDistance = std.abs(std.length(point) - radius);
    const ring = (1 - std.smoothstep(0.2, 1.5 + footprint, ringDistance))
        * (1 - std.smoothstep(0.55, 1, phase));
    const ringStrength = 0.15 * p.pulse.y * active * quiet * ordinaryRings;
    color = std.add(color, std.mul(palette, ring * ringStrength));

    // Soft geometric edge glow: two opposite highlights travel around the square once per bar.
    const angle = std.atan2(point.y, point.x);
    const rimPhase = angle - phase * 6.28318530718;
    const rimLight = std.pow(0.5 + 0.5 * std.cos(rimPhase * 2), 6);
    const rim = std.smoothstep(16.7, 17.6, edge) * inside;
    color = std.add(color, std.mul(palette, rim * (0.025 + (rimLight * 0.2 + p.pulse.x * 0.16) * active * ordinaryRings)));

    // High detail adds a quiet warped grid; the first grid always stays fixed.
    const warp = d.vec2f(
        std.sin(point.y * 0.21 + bar * 1.57079632679),
        std.sin(point.x * 0.18 - bar * 1.57079632679),
    );
    const shifted = std.add(point, std.mul(warp, 0.45));
    const secondaryGrid = gridLine(std.add(shifted, d.vec2f(1.5)), 0.012, footprint);
    color = std.add(color, std.mul(palette, secondaryGrid * 0.12 * active * quiet * p.response.z));

    // One broad, colored shockwave. It begins near the center immediately, with
    // a quieter player zone and no white flash or secondary front.
    color = std.add(color, std.mul(targetAccent, wave.y * (0.5 + quiet * 0.5) * 0.95));
    // The held center gathers light before launch, then releases over one beat.
    // Keeping the old accent at progress zero avoids a color jump at the boundary.
    const chargePalette = std.mix(d.vec3f(p.fromAccent.x, p.fromAccent.y, p.fromAccent.z),
        targetAccent, std.smoothstep(0, 0.12, p.section.x));
    color = std.add(color, std.mul(chargePalette, sectionCharge(p.section.w * p.pulse.w, distance) * 0.45));
    return d.vec4f(std.min(std.mul(color, inside), d.vec3f(0.23)), 1);
});

const FLOOR_DEFAULTS = {
    clock: d.vec4f(0),
    pulse: d.vec4f(0),
    response: d.vec4f(0, 0, 1, 0),
    player: d.vec2f(0),
    section: d.vec4f(0),
    floorColor: d.vec4f(0.008, 0.017, 0.023, 1),
    lineColor: d.vec4f(0.027, 0.083, 0.093, 1),
    accentColor: d.vec4f(0.055, 0.29, 0.25, 1),
    fromFloor: d.vec4f(0.008, 0.017, 0.023, 1),
    fromLine: d.vec4f(0.027, 0.083, 0.093, 1),
    fromAccent: d.vec4f(0.055, 0.29, 0.25, 1),
};

const MusicFloorMaterial = materialType({
    name: "Beatshooter/MusicFloor",
    parameters: FloorParameters,
    defaults: FLOOR_DEFAULTS,
    vertex: (input) => {
        "use gpu";
        const surface = shockwaveSurface(
            input.parameters.section.x,
            input.parameters.section.y * input.parameters.pulse.w,
            input.world.xyz,
            input.worldNormal,
        );
        return { world: d.vec4f(surface.position, input.world.w), worldNormal: surface.normal };
    },
    fragment: (context) => {
        "use gpu";
        return shadeFloor(context.parameters, d.vec2f(context.world.x, context.world.z));
    },
});
const FloorRegistration = MaterialPlugin(MusicFloorMaterial);

interface FloorState {
    status: "pending" | "ready" | "fallback";
    error?: string;
    material?: MaterialHandle;
    lastInput: MusicFloorInput;
    hiddenLines: number[];
    arenaPaletteApplied: boolean;
    arenaPalette: number[];
    parameters: {
        clock: [number, number, number, number];
        pulse: [number, number, number, number];
        response: [number, number, number, number];
        player: [number, number];
        section: [number, number, number, number];
        floorColor: [number, number, number, number];
        lineColor: [number, number, number, number];
        accentColor: [number, number, number, number];
        fromFloor: [number, number, number, number];
        fromLine: [number, number, number, number];
        fromAccent: [number, number, number, number];
    };
}

export const MusicFloorState: Resource<FloorState> = {
    create: () => ({
        status: "pending",
        lastInput: { ...IDLE_INPUT },
        hiddenLines: [],
        arenaPaletteApplied: false,
        arenaPalette: Array(9).fill(0),
        parameters: {
            clock: [0, 0, 0, 0], pulse: [0, 0, 0, 0],
            response: [0, 0, 1, 0], player: [0, 0],
            section: [0, 0, 0, 0],
            floorColor: [0.008, 0.017, 0.023, 1],
            lineColor: [0.027, 0.083, 0.093, 1],
            accentColor: [0.055, 0.29, 0.25, 1],
            fromFloor: [0.008, 0.017, 0.023, 1],
            fromLine: [0.027, 0.083, 0.093, 1],
            fromAccent: [0.055, 0.29, 0.25, 1],
        },
    }),
};

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const smoothUnit = (value: number): number => {
    const t = unit(value);
    return t * t * (3 - 2 * t);
};

/**
 * Shared perimeter materials and the original fallback floor follow the same theme.
 * Updates use retained handles, with no material allocation during a section change.
 */
function updateArenaPalette(world: World, state: FloorState): void {
    const section = state.lastInput.section;
    if (!section && !state.arenaPaletteApplied) return;
    const traveling = !!section?.from && section.strength > 0;
    const floorBlend = traveling ? smoothUnit(section!.progress) : 1;
    // The shared perimeter changes once the outward front begins reaching the
    // arena's sides. A fallback grid uses the softer whole-floor fade instead.
    const edgeBlend = traveling ? smoothUnit((section!.progress - 0.55) / 0.35) : 1;
    const lineBlend = state.status === "fallback" ? floorBlend : edgeBlend;
    const channel = (kind: "floor" | "line" | "accent", lane: number, blend: number): number => {
        const target = section![kind][lane]!;
        const from = section!.from?.[kind][lane] ?? target;
        return from + (target - from) * blend;
    };
    if (section) {
        let changed = !state.arenaPaletteApplied;
        for (let lane = 0; lane < 3; lane++) {
            changed ||= state.arenaPalette[lane] !== channel("floor", lane, floorBlend)
                || state.arenaPalette[lane + 3] !== channel("line", lane, lineBlend)
                || state.arenaPalette[lane + 6] !== channel("accent", lane, edgeBlend);
        }
        if (!changed) return;
    }
    const arena = world.resource(Arena);
    // CPU-only compositions may sample visuals before the arena has been initialized.
    if (!arena.materials.floor || !arena.materials.line || !arena.materials.wall) return;
    const materials = world.resource(Materials);
    if (section) {
        for (let lane = 0; lane < 3; lane++) {
            state.arenaPalette[lane] = channel("floor", lane, floorBlend);
            state.arenaPalette[lane + 3] = channel("line", lane, lineBlend);
            state.arenaPalette[lane + 6] = channel("accent", lane, edgeBlend);
        }
        const [fr, fg, fb, lr, lg, lb, ar, ag, ab] = state.arenaPalette;
        materials.update(arena.materials.floor, { baseColor: [fr! * 0.75, fg! * 0.75, fb! * 0.75, 1] });
        materials.update(arena.materials.line, { baseColor: [lr! * 1.12, lg! * 1.12, lb! * 1.12, 1] });
        materials.update(arena.materials.wall, { baseColor: [ar! * 0.62, ag! * 0.62, ab! * 0.62, 1] });
        if (arena.materials.rim) {
            materials.update(arena.materials.rim, { baseColor: [ar! * 4, ag! * 4, ab! * 4, 1] });
        }
    } else {
        materials.update(arena.materials.floor, { baseColor: [0.006, 0.012, 0.018, 1] });
        materials.update(arena.materials.line, { baseColor: [0.03, 0.09, 0.105, 1] });
        materials.update(arena.materials.wall, { baseColor: [0.07, 0.19, 0.21, 1] });
        if (arena.materials.rim) materials.update(arena.materials.rim, { baseColor: [0.13, 1.15, 1, 1] });
    }
    state.arenaPaletteApplied = !!section;
}

/** Pure, absolute-time sampling makes repeated draws and pause frames idempotent. */
export function updateMusicFloor(world: World, input: MusicFloorInput): void {
    const state = world.resource(MusicFloorState);
    const current = state.lastInput;
    current.beatCoordinate = finite(input.beatCoordinate);
    current.beatPhase = unit(input.beatPhase);
    current.barCoordinate = finite(input.barCoordinate);
    current.barPhase = unit(input.barPhase);
    current.beatPulse = unit(input.beatPulse);
    current.downbeatPulse = unit(input.downbeatPulse);
    current.intensity = unit(input.intensity);
    current.energy = unit(input.energy);
    current.bass = unit(input.bass);
    current.playerX = finite(input.playerX);
    current.playerZ = finite(input.playerZ);
    current.motionAllowed = input.motionAllowed;
    current.highQuality = input.highQuality;
    if (input.section) {
        const section = current.section ??= {
            progress: 0, strength: 0, floor: [0, 0, 0], line: [0, 0, 0], accent: [0, 0, 0],
        };
        section.progress = unit(input.section.progress);
        section.strength = current.motionAllowed ? unit(input.section.strength) : 0;
        section.charge = current.motionAllowed ? unit(input.section.charge ?? 0) : 0;
        if (input.section.from) {
            section.from ??= { floor: [0, 0, 0], line: [0, 0, 0], accent: [0, 0, 0] };
            for (let lane = 0; lane < 3; lane++) {
                section.from.floor[lane] = unit(input.section.from.floor[lane]!);
                section.from.line[lane] = unit(input.section.from.line[lane]!);
                section.from.accent[lane] = unit(input.section.from.accent[lane]!);
            }
        } else {
            section.from = undefined;
        }
        for (let lane = 0; lane < 3; lane++) {
            section.floor[lane] = unit(input.section.floor[lane]!);
            section.line[lane] = unit(input.section.line[lane]!);
            section.accent[lane] = unit(input.section.accent[lane]!);
        }
    } else {
        current.section = undefined;
    }
    updateArenaPalette(world, state);
    const parameters = state.parameters;
    parameters.clock[0] = current.beatCoordinate;
    parameters.clock[1] = current.beatPhase;
    parameters.clock[2] = current.barCoordinate;
    parameters.clock[3] = current.barPhase;
    parameters.pulse[0] = current.beatPulse;
    parameters.pulse[1] = current.downbeatPulse;
    parameters.pulse[2] = current.intensity;
    parameters.pulse[3] = current.motionAllowed ? 1 : 0;
    parameters.response[0] = current.energy;
    parameters.response[1] = current.bass;
    parameters.response[2] = current.highQuality ? 1 : 0;
    parameters.player[0] = current.playerX;
    parameters.player[1] = current.playerZ;
    parameters.section[0] = current.section?.progress ?? 0;
    parameters.section[1] = current.section?.strength ?? 0;
    parameters.section[2] = current.section ? 1 : 0;
    parameters.section[3] = current.section?.charge ?? 0;
    const { floorColor, lineColor, accentColor, fromFloor, fromLine, fromAccent } = parameters;
    for (let lane = 0; lane < 3; lane++) {
        floorColor[lane] = current.section?.floor[lane] ?? FLOOR_DEFAULTS.floorColor[lane]!;
        lineColor[lane] = current.section?.line[lane] ?? FLOOR_DEFAULTS.lineColor[lane]!;
        accentColor[lane] = current.section?.accent[lane] ?? FLOOR_DEFAULTS.accentColor[lane]!;
        fromFloor[lane] = current.section?.from?.floor[lane] ?? floorColor[lane]!;
        fromLine[lane] = current.section?.from?.line[lane] ?? lineColor[lane]!;
        fromAccent[lane] = current.section?.from?.accent[lane] ?? accentColor[lane]!;
    }
    if (state.status !== "ready" || !state.material) return;
    world.resource(MusicFloorMaterial).update(state.material, parameters);
}

/**
 * Validate the exact floor function before registering its material with the renderer.
 * A shader/compiler error leaves the original arena intact instead of failing app startup.
 * The standard renderer then prewarms the registered material under its loading screen.
 */
export function musicFloorShaderSource(): string {
    return tgpu.resolve({
        externals: { FloorParameters, shadeFloor, shockwaveSurface },
        template: `
@group(0) @binding(0) var<uniform> floorParameters: FloorParameters;
struct FloorVertexOutput {
    @builtin(position) clip: vec4f,
    @location(0) world: vec3f,
};
@vertex fn floorVertex(@builtin(vertex_index) i: u32) -> FloorVertexOutput {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    let world = vec3f(x * 2 - 1, 0, y * 2 - 1);
    let surface = shockwaveSurface(
        floorParameters.section.x,
        floorParameters.section.y * floorParameters.pulse.w,
        world,
        vec3f(0, 1, 0)
    );
    return FloorVertexOutput(
        vec4f(surface.position.x, surface.position.z + surface.position.y * 0.1, 0, 1),
        surface.position
    );
}
@fragment fn floorFragment(@location(0) world: vec3f) -> @location(0) vec4f {
    return shadeFloor(floorParameters, world.xz);
}`,
    });
}

async function preflightFloor(world: World): Promise<void> {
    const device = world.gpu.device;
    device.pushErrorScope("validation");
    let caught: unknown;
    try {
        const code = musicFloorShaderSource();
        const module = device.createShaderModule({ label: "Beatshooter floor validation", code });
        const compilation = await module.getCompilationInfo();
        const errors = compilation.messages.filter(message => message.type === "error");
        if (errors.length) throw new Error(errors.map(message => message.message).join("\n"));
        await device.createRenderPipelineAsync({
            label: "Beatshooter floor prewarm",
            layout: "auto",
            vertex: { module, entryPoint: "floorVertex" },
            fragment: { module, entryPoint: "floorFragment", targets: [{ format: "rgba16float" }] },
            primitive: { topology: "triangle-list" },
        });
    } catch (error) {
        caught = error;
    }
    const validation = await device.popErrorScope();
    if (caught) throw caught;
    if (validation) throw new Error(validation.message);
}

export const MusicFloorPlugin: Plugin = {
    name: "Beatshooter/MusicFloor",
    gpu: {},
    dependencies: [ArenaPlugin],
    components: FloorRegistration.components,
    async initialize(world) {
        const state = world.resource(MusicFloorState);
        const arena = world.resource(Arena);
        const original = world.get(arena.floor, MeshMaterial);
        try {
            await preflightFloor(world);
            // Registration is delayed until shader validation succeeds, so a failed shader is
            // never included in the renderer's global material warm-up. This wrapper retains
            // the public registration plugin's components and delegates its initializer.
            await FloorRegistration.initialize!(world);
            state.material = world.resource(MusicFloorMaterial).add(FLOOR_DEFAULTS);
            const materials = world.storage(MeshMaterial);
            materials.type.set(arena.floor, state.material.type);
            materials.material.set(arena.floor, state.material.material);
            for (const eid of arena.lines) {
                if (!world.has(eid, MeshInstance)) continue;
                world.remove(eid, MeshInstance);
                state.hiddenLines.push(eid);
            }
            state.status = "ready";
            updateMusicFloor(world, state.lastInput);
        } catch (error) {
            if (original) {
                const materials = world.storage(MeshMaterial);
                materials.type.set(arena.floor, original.type);
                materials.material.set(arena.floor, original.material);
            }
            for (const eid of state.hiddenLines) world.add(eid, MeshInstance);
            state.hiddenLines.length = 0;
            if (state.material) {
                world.resource(MusicFloorMaterial).remove(state.material);
                state.material = undefined;
            }
            state.status = "fallback";
            state.error = error instanceof Error ? error.message : String(error);
            console.warn("Music floor unavailable; using the static arena.", error);
        }
    },
};
