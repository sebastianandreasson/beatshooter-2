import { Materials, MeshInstance, MeshMaterial, type Plugin, type Resource, type World } from "@dylanebert/shallot";
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
    /** Absolute section progress and its persistent palette, independent of beat pulses. */
    section?: {
        progress: number;
        strength: number;
        /** Cosmetic floor transform only; the camera, actors and collisions remain fixed. */
        mapRoll?: number;
        mapDrop?: number;
        floor: [number, number, number];
        line: [number, number, number];
        accent: [number, number, number];
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
    map: d.vec4f,
    floorColor: d.vec4f,
    lineColor: d.vec4f,
    accentColor: d.vec4f,
});

/** Undo the visual floor's Z-axis turn and downward travel before sampling its pattern. */
export const musicFloorCoordinates = tgpu.fn([d.vec4f, d.vec3f], d.vec2f)((map, world) => {
    "use gpu";
    return d.vec2f(world.x * map.x + (world.y + map.z) * map.y, world.z);
});

const gridLine = tgpu.fn([d.vec2f, d.f32, d.f32], d.f32)((point, width, footprint) => {
    "use gpu";
    const cell = std.abs(std.sub(std.fract(std.add(std.div(point, 3), 0.5)), 0.5));
    const distance = std.min(cell.x, cell.y) * 3;
    return 1 - std.smoothstep(width, width + footprint, distance);
});

/**
 * Ground-only radiance: no vertex displacement or lighting/exposure changes.
 * The static grid provides orientation beneath the section's spiral and expanding light wave.
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
    const palette = d.vec3f(
        p.accentColor.x + slow * 0.009 * (1 - p.section.z),
        p.accentColor.y,
        p.accentColor.z - slow * 0.022 * (1 - p.section.z),
    );
    const base = d.vec3f(p.floorColor.x, p.floorColor.y, p.floorColor.z);
    const staticLines = d.vec3f(p.lineColor.x, p.lineColor.y, p.lineColor.z);
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

    // A section change opens a moving radial tunnel across the whole floor. Its clock
    // comes from the authored section/beat boundaries, so pause and slowdown freeze it.
    // The player zone stays quieter and the fixed grid is never removed.
    if (p.section.y > 0 && p.pulse.w > 0) {
        const travel = p.section.x;
        const envelope = std.pow(std.sin(travel * 3.14159265359), 2) * p.section.y;
        const distance = std.length(point);
        const radius = travel * 37;
        const leadingWave = 1 - std.smoothstep(0.35, 2.2 + footprint, std.abs(distance - radius));
        const trailingWave = 1 - std.smoothstep(0.18, 0.9 + footprint, std.abs(distance - radius + 4.5));
        const zone = 0.28 + quiet * 0.72;
        const wave = leadingWave * 0.68 + trailingWave * 0.25;
        color = std.add(color, std.mul(palette, wave * envelope * zone));
        color = std.add(color, std.mul(palette, rim * envelope * 0.38));

        // High detail bends a second grid into the tunnel and threads it with radial
        // lanes. Low detail retains the broad wave and palette without this extra work.
        if (p.response.z > 0.5) {
            const twist = travel * 4.71238898038
                + (1 - std.smoothstep(0, 28, distance)) * envelope * 1.7;
            const cs = std.cos(twist);
            const sn = std.sin(twist);
            const zoom = 1 + envelope * 3.2;
            const tunnelPoint = std.mul(d.vec2f(
                point.x * cs - point.y * sn,
                point.x * sn + point.y * cs,
            ), zoom);
            const tunnelGrid = gridLine(tunnelPoint, 0.027, footprint * zoom);
            const lanes = std.pow(0.5 + 0.5 * std.cos(angle * 10 - distance * 0.24 + travel * 12.5663706144), 14);
            const depth = 0.4 + (1 - std.smoothstep(2, 27, distance)) * 0.6;
            color = std.add(color, std.mul(palette,
                (tunnelGrid * 0.43 + lanes * 0.24) * envelope * zone * depth));
        }
    }
    return d.vec4f(std.min(std.mul(color, inside), d.vec3f(0.23)), 1);
});

const FLOOR_DEFAULTS = {
    clock: d.vec4f(0),
    pulse: d.vec4f(0),
    response: d.vec4f(0, 0, 1, 0),
    player: d.vec2f(0),
    section: d.vec4f(0),
    map: d.vec4f(1, 0, 0, 0),
    floorColor: d.vec4f(0.008, 0.017, 0.023, 1),
    lineColor: d.vec4f(0.027, 0.083, 0.093, 1),
    accentColor: d.vec4f(0.055, 0.29, 0.25, 1),
};

const MusicFloorMaterial = materialType({
    name: "Beatshooter/MusicFloor",
    parameters: FloorParameters,
    defaults: FLOOR_DEFAULTS,
    fragment: (context) => {
        "use gpu";
        return shadeFloor(context.parameters, musicFloorCoordinates(context.parameters.map, context.world));
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
        map: [number, number, number, number];
        floorColor: [number, number, number, number];
        lineColor: [number, number, number, number];
        accentColor: [number, number, number, number];
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
            map: [1, 0, 0, 0],
            floorColor: [0.008, 0.017, 0.023, 1],
            lineColor: [0.027, 0.083, 0.093, 1],
            accentColor: [0.055, 0.29, 0.25, 1],
        },
    }),
};

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const finite = (value: number): number => Number.isFinite(value) ? value : 0;

/**
 * Shared perimeter materials and the original fallback floor follow the same theme.
 * Updates use retained handles, with no material allocation during a section change.
 */
function updateArenaPalette(world: World, state: FloorState): void {
    const section = state.lastInput.section;
    if (!section && !state.arenaPaletteApplied) return;
    if (section) {
        let changed = !state.arenaPaletteApplied;
        for (let lane = 0; lane < 3; lane++) {
            changed ||= state.arenaPalette[lane] !== section.floor[lane]
                || state.arenaPalette[lane + 3] !== section.line[lane]
                || state.arenaPalette[lane + 6] !== section.accent[lane];
        }
        if (!changed) return;
    }
    const arena = world.resource(Arena);
    // CPU-only compositions may sample visuals before the arena has been initialized.
    if (!arena.materials.floor || !arena.materials.line || !arena.materials.wall) return;
    const materials = world.resource(Materials);
    if (section) {
        const [fr, fg, fb] = section.floor;
        const [lr, lg, lb] = section.line;
        const [ar, ag, ab] = section.accent;
        materials.update(arena.materials.floor, { baseColor: [fr * 0.75, fg * 0.75, fb * 0.75, 1] });
        materials.update(arena.materials.line, { baseColor: [lr * 1.12, lg * 1.12, lb * 1.12, 1] });
        materials.update(arena.materials.wall, { baseColor: [ar * 0.62, ag * 0.62, ab * 0.62, 1] });
        for (let lane = 0; lane < 3; lane++) {
            state.arenaPalette[lane] = section.floor[lane]!;
            state.arenaPalette[lane + 3] = section.line[lane]!;
            state.arenaPalette[lane + 6] = section.accent[lane]!;
        }
    } else {
        materials.update(arena.materials.floor, { baseColor: [0.006, 0.012, 0.018, 1] });
        materials.update(arena.materials.line, { baseColor: [0.03, 0.09, 0.105, 1] });
        materials.update(arena.materials.wall, { baseColor: [0.07, 0.19, 0.21, 1] });
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
        section.mapRoll = current.motionAllowed ? finite(input.section.mapRoll ?? 0) : 0;
        section.mapDrop = current.motionAllowed ? finite(input.section.mapDrop ?? 0) : 0;
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
    parameters.map[0] = Math.cos(current.section?.mapRoll ?? 0);
    parameters.map[1] = Math.sin(current.section?.mapRoll ?? 0);
    parameters.map[2] = current.section?.mapDrop ?? 0;
    const { floorColor, lineColor, accentColor } = parameters;
    for (let lane = 0; lane < 3; lane++) {
        floorColor[lane] = current.section?.floor[lane] ?? FLOOR_DEFAULTS.floorColor[lane]!;
        lineColor[lane] = current.section?.line[lane] ?? FLOOR_DEFAULTS.lineColor[lane]!;
        accentColor[lane] = current.section?.accent[lane] ?? FLOOR_DEFAULTS.accentColor[lane]!;
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
        externals: { FloorParameters, shadeFloor, musicFloorCoordinates },
        template: `
@group(0) @binding(0) var<uniform> floorParameters: FloorParameters;
@vertex fn floorVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4f(x * 2 - 1, y * 2 - 1, 0, 1);
}
@fragment fn floorFragment(@builtin(position) point: vec4f) -> @location(0) vec4f {
    return shadeFloor(floorParameters, musicFloorCoordinates(floorParameters.map, vec3f(point.x, 0, point.y)));
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
