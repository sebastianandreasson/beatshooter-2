import { expect, test } from "bun:test";
import { createApp, Materials, StandardMaterial } from "@dylanebert/shallot";
import { Arena } from "../arena";
import {
    MusicFloorState, sectionShockwave, musicFloorShaderSource, updateMusicFloor, type MusicFloorInput,
} from "./floor";

const input = (): MusicFloorInput => ({
    beatCoordinate: 12.5, beatPhase: 0.5, barCoordinate: 3.125, barPhase: 0.125,
    beatPulse: 0.3, downbeatPulse: 0.1, intensity: 0.85, energy: 0.5, bass: 0.4,
    playerX: 1, playerZ: 2, motionAllowed: true, highQuality: true,
});

test("section palette reaches the static fallback and restores original arena colors on cleanup", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    try {
        const { world } = app;
        const materials = world.resource(Materials);
        const arena = world.resource(Arena);
        arena.materials.floor = materials.add(StandardMaterial({ baseColor: [0.006, 0.012, 0.018, 1] }));
        arena.materials.line = materials.add(StandardMaterial({ baseColor: [0.03, 0.09, 0.105, 1] }));
        arena.materials.wall = materials.add(StandardMaterial({ baseColor: [0.07, 0.19, 0.21, 1] }));
        const original = [arena.materials.floor, arena.materials.line, arena.materials.wall]
            .map(handle => materials.get(handle));
        const state = world.resource(MusicFloorState);
        state.status = "fallback";
        const frame = input();
        frame.section = {
            progress: 0.45, strength: 0.85,
            floor: [0.018, 0.009, 0.028], line: [0.071, 0.034, 0.099], accent: [0.26, 0.08, 0.32],
        };
        updateMusicFloor(world, frame);
        expect(materials.get(arena.materials.floor)!.baseColor.x).toBeCloseTo(0.018 * 0.75);
        expect(materials.get(arena.materials.line)!.baseColor.z).toBeCloseTo(0.099 * 1.12);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.26 * 0.62);
        expect(state.parameters.floorColor).toEqual([0.018, 0.009, 0.028, 1]);
        expect(state.parameters.section).toEqual([0.45, 0.85, 1, 0]);
        expect(state.parameters.fromFloor).toEqual(state.parameters.floorColor);
        const held = structuredClone(state.parameters);
        for (let draw = 0; draw < 20; draw++) updateMusicFloor(world, frame);
        expect(state.parameters).toEqual(held);

        // Frames keep their own palette copy; mutating the caller cannot silently recolor a paused map.
        frame.section.floor[0] = 0.025;
        expect(state.lastInput.section!.floor[0]).toBe(0.018);
        updateMusicFloor(world, input());
        expect(state.lastInput.section).toBeUndefined();
        expect(state.parameters.section).toEqual([0, 0, 0, 0]);
        for (const [lane, value] of [0.008, 0.017, 0.023].entries()) {
            expect(state.parameters.floorColor[lane]).toBeCloseTo(value);
        }
        expect([arena.materials.floor, arena.materials.line, arena.materials.wall]
            .map(handle => materials.get(handle))).toEqual(original);
    } finally {
        app.dispose();
    }
});

test("comfort settings keep the section palette while independently disabling motion and detail", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    try {
        const { world } = app;
        const frame = input();
        frame.motionAllowed = false;
        frame.highQuality = false;
        frame.section = {
            progress: 0.7, strength: 1,
            floor: [0.009, 0.014, 0.026], line: [0.03, 0.064, 0.1], accent: [0.06, 0.17, 0.31],
        };
        updateMusicFloor(world, frame);
        const state = world.resource(MusicFloorState);
        expect(state.parameters.section).toEqual([0.7, 0, 1, 0]);
        expect(state.parameters.accentColor).toEqual([0.06, 0.17, 0.31, 1]);
        expect(state.parameters.pulse[3]).toBe(0);
        expect(state.parameters.response[2]).toBe(0);
        // Position from the song, rather than renderer time, is the only effect clock.
        const held = structuredClone(state.parameters);
        updateMusicFloor(world, frame);
        expect(state.parameters).toEqual(held);
    } finally {
        app.dispose();
    }
});

test("one outward wave paints only the space behind it and stays visible near its origin", () => {
    expect(sectionShockwave(0.03, 1, 0.9, 0.01).y).toBeGreaterThan(0.4);
    expect(sectionShockwave(0, 1, 0, 0.01).y).toBe(0);
    for (const progress of [0.2, 0.5, 0.8]) {
        const radius = progress * 30;
        expect(sectionShockwave(progress, 1, radius - 2, 0.01).x).toBe(1);
        expect(sectionShockwave(progress, 1, radius + 2, 0.01).x).toBe(0);
        expect(sectionShockwave(progress, 1, radius, 0.01).y).toBeCloseTo(1);
        let fronts = 0, wasLit = false;
        for (let distance = 0; distance <= 30; distance += 0.1) {
            const lit = sectionShockwave(progress, 1, distance, 0.01).y > 0.001;
            if (lit && !wasLit) fronts++;
            wasLit = lit;
        }
        expect(fronts).toBe(1);
    }
    for (const distance of [0, 8, 18, Math.hypot(18.5, 18.5)]) {
        const final = sectionShockwave(1, 1, distance, 0.01);
        expect(final.x).toBe(1);
        expect(final.y).toBe(0);
        expect(sectionShockwave(0.4, 0, distance, 0.01)).toEqual(final);
    }
});

test("fallback colors fade smoothly and perimeter colors wait until the wave reaches the sides", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    try {
        const { world } = app, materials = world.resource(Materials), arena = world.resource(Arena);
        for (const kind of ["floor", "line", "wall"] as const) {
            arena.materials[kind] = materials.add(StandardMaterial());
        }
        const state = world.resource(MusicFloorState);
        state.status = "fallback";
        const frame = input();
        frame.section = {
            progress: 0, strength: 0.85,
            floor: [0.025, 0.01, 0.03], line: [0.09, 0.03, 0.1], accent: [0.32, 0.08, 0.35],
            from: { floor: [0.008, 0.017, 0.023], line: [0.027, 0.083, 0.093], accent: [0.055, 0.29, 0.25] },
        };
        updateMusicFloor(world, frame);
        const startFloor = materials.get(arena.materials.floor)!.baseColor.x;
        const startWall = materials.get(arena.materials.wall)!.baseColor.x;
        expect(startFloor).toBeCloseTo(0.008 * 0.75);
        expect(startWall).toBeCloseTo(0.055 * 0.62);
        expect(state.parameters.fromFloor).toEqual([0.008, 0.017, 0.023, 1]);
        frame.section.progress = 0.45;
        updateMusicFloor(world, frame);
        expect(materials.get(arena.materials.floor)!.baseColor.x).toBeGreaterThan(startFloor);
        expect(materials.get(arena.materials.floor)!.baseColor.x).toBeLessThan(0.025 * 0.75);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBe(startWall);
        frame.section.progress = 0.7;
        updateMusicFloor(world, frame);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBeGreaterThan(startWall);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBeLessThan(0.32 * 0.62);
        frame.section.progress = 1;
        updateMusicFloor(world, frame);
        expect(materials.get(arena.materials.floor)!.baseColor.x).toBeCloseTo(0.025 * 0.75);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.32 * 0.62);
    } finally {
        app.dispose();
    }
});

test("the production floor preflight resolves both vertex bulging and world-XZ color sampling", () => {
    const source = musicFloorShaderSource();
    expect(source).toContain("fn floorVertex");
    expect(source).toContain("@fragment fn floorFragment");
    expect(source).toContain("shockwaveSurface(");
    expect(source).toContain("surface.position.y * 0.1");
    expect(source).toContain("world.xz");
    expect(source).toContain("floorColor: vec4f");
    expect(source).toContain("accentColor: vec4f");
    expect(source).not.toContain("NaN");
});
