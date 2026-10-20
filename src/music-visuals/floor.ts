import { MeshInstance, MeshMaterial, type Plugin, type Resource, type World } from "@dylanebert/shallot";
import { MaterialPlugin, materialType, type MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import tgpu from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";
import { Arena, ArenaPlugin } from "../arena";

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
}

const IDLE_INPUT: Readonly<MusicFloorInput> = Object.freeze({
    beatCoordinate: 0, beatPhase: 0, barCoordinate: 0, barPhase: 0,
    beatPulse: 0, downbeatPulse: 0, intensity: 0, energy: 0, bass: 0,
    playerX: 0, playerZ: 0, motionAllowed: false, highQuality: true,
});

/** Four short rows keep uploads small and do not allocate GPU resources on a beat. */
const FloorParameters = d.struct({
    clock: d.vec4f,
    pulse: d.vec4f,
    response: d.vec4f,
    player: d.vec2f,
});

const gridLine = tgpu.fn([d.vec2f, d.f32, d.f32], d.f32)((point, width, footprint) => {
    "use gpu";
    const cell = std.abs(std.sub(std.fract(std.add(std.div(point, 3), 0.5)), 0.5));
    const distance = std.min(cell.x, cell.y) * 3;
    return 1 - std.smoothstep(width, width + footprint, distance);
});

/**
 * Ground-only radiance: no vertex displacement, lighting/exposure changes, or screen distortion.
 * The static grid provides orientation while the lower-contrast secondary layer moves beneath it.
 */
const shadeFloor = tgpu.fn([FloorParameters, d.vec2f], d.vec4f)((p, point) => {
    "use gpu";
    const footprint = std.max(std.max(std.fwidth(point.x), std.fwidth(point.y)), 0.012);
    const baseGrid = gridLine(point, 0.016, footprint);
    const active = p.pulse.z * p.pulse.w;
    const beat = p.clock.x * p.pulse.w;
    const bar = p.clock.z * p.pulse.w;
    const phase = p.clock.w;
    const quiet = std.smoothstep(1.4, 5.5, std.length(std.sub(point, p.player)));
    const edge = std.max(std.abs(point.x), std.abs(point.y));
    const inside = 1 - std.smoothstep(17.8, 18.5, edge);
    const slow = std.sin(bar * 0.78539816339) * active;
    const palette = d.vec3f(0.055 + slow * 0.009, 0.29, 0.25 - slow * 0.022);
    const base = d.vec3f(0.008, 0.017, 0.023);
    const staticLines = d.vec3f(0.027, 0.083, 0.093);
    const pulse = p.pulse.x * (0.045 + p.response.y * 0.045);
    let color = std.add(base, std.mul(staticLines, baseGrid));
    color = std.add(color, std.mul(palette, baseGrid * pulse * active * quiet));

    // One low-frequency diagonal light band travels one full period per four beats.
    const bandPhase = (point.x + point.y) * 0.16 - beat * 1.57079632679;
    const broadBand = std.pow(0.5 + 0.5 * std.sin(bandPhase), 3);
    color = std.add(color, std.mul(palette, broadBand * (0.045 + p.response.x * 0.035) * active * quiet));

    // The ring traverses the arena over the current actual bar, then fades before resetting.
    const radius = phase * 27;
    const ringDistance = std.abs(std.length(point) - radius);
    const ring = (1 - std.smoothstep(0.2, 1.5 + footprint, ringDistance))
        * (1 - std.smoothstep(0.55, 1, phase));
    const ringStrength = 0.15 * p.pulse.y * active * quiet;
    color = std.add(color, std.mul(palette, ring * ringStrength));

    // Soft geometric edge glow: two opposite highlights travel around the square once per bar.
    const angle = std.atan2(point.y, point.x);
    const rimPhase = angle - phase * 6.28318530718;
    const rimLight = std.pow(0.5 + 0.5 * std.cos(rimPhase * 2), 6);
    const rim = std.smoothstep(16.7, 17.6, edge) * inside;
    color = std.add(color, std.mul(palette, rim * (0.025 + rimLight * 0.25 * active)));

    // High detail adds a quiet warped grid; the first grid always stays fixed.
    const warp = d.vec2f(
        std.sin(point.y * 0.21 + bar * 1.57079632679),
        std.sin(point.x * 0.18 - bar * 1.57079632679),
    );
    const shifted = std.add(point, std.mul(warp, 0.45));
    const secondaryGrid = gridLine(std.add(shifted, d.vec2f(1.5)), 0.012, footprint);
    color = std.add(color, std.mul(palette, secondaryGrid * 0.12 * active * quiet * p.response.z));
    return d.vec4f(std.min(std.mul(color, inside), d.vec3f(0.23)), 1);
});

const FLOOR_DEFAULTS = {
    clock: d.vec4f(0),
    pulse: d.vec4f(0),
    response: d.vec4f(0, 0, 1, 0),
    player: d.vec2f(0),
};

const MusicFloorMaterial = materialType({
    name: "Beatshooter/MusicFloor",
    parameters: FloorParameters,
    defaults: FLOOR_DEFAULTS,
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
    parameters: {
        clock: [number, number, number, number];
        pulse: [number, number, number, number];
        response: [number, number, number, number];
        player: [number, number];
    };
}

export const MusicFloorState: Resource<FloorState> = {
    create: () => ({
        status: "pending",
        lastInput: { ...IDLE_INPUT },
        hiddenLines: [],
        parameters: {
            clock: [0, 0, 0, 0], pulse: [0, 0, 0, 0],
            response: [0, 0, 1, 0], player: [0, 0],
        },
    }),
};

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const finite = (value: number): number => Number.isFinite(value) ? value : 0;

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
    if (state.status !== "ready" || !state.material) return;
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
    world.resource(MusicFloorMaterial).update(state.material, parameters);
}

/**
 * Validate the exact floor function before registering its material with the renderer.
 * A shader/compiler error leaves the original arena intact instead of failing app startup.
 * The standard renderer then prewarms the registered material under its loading screen.
 */
export function musicFloorShaderSource(): string {
    return tgpu.resolve({
        externals: { FloorParameters, shadeFloor },
        template: `
@group(0) @binding(0) var<uniform> floorParameters: FloorParameters;
@vertex fn floorVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4f(x * 2 - 1, y * 2 - 1, 0, 1);
}
@fragment fn floorFragment(@builtin(position) point: vec4f) -> @location(0) vec4f {
    return shadeFloor(floorParameters, point.xy);
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
