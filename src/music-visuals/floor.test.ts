import { expect, test } from "bun:test";
import { createApp, Materials, StandardMaterial } from "@dylanebert/shallot";
import * as d from "typegpu/data";
import { Arena } from "../arena";
import {
    MusicFloorState, musicFloorCoordinates, musicFloorShaderSource, updateMusicFloor, type MusicFloorInput,
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
            progress: 0.45, strength: 0.85, mapRoll: Math.PI * 0.75, mapDrop: 12,
            floor: [0.018, 0.009, 0.028], line: [0.071, 0.034, 0.099], accent: [0.26, 0.08, 0.32],
        };
        updateMusicFloor(world, frame);
        expect(materials.get(arena.materials.floor)!.baseColor.x).toBeCloseTo(0.018 * 0.75);
        expect(materials.get(arena.materials.line)!.baseColor.z).toBeCloseTo(0.099 * 1.12);
        expect(materials.get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.26 * 0.62);
        expect(state.parameters.floorColor).toEqual([0.018, 0.009, 0.028, 1]);
        expect(state.parameters.section).toEqual([0.45, 0.85, 1, 0]);
        expect(state.parameters.map).toEqual([Math.cos(Math.PI * 0.75), Math.sin(Math.PI * 0.75), 12, 0]);
        const held = structuredClone(state.parameters);
        for (let draw = 0; draw < 20; draw++) updateMusicFloor(world, frame);
        expect(state.parameters).toEqual(held);

        // Frames keep their own palette copy; mutating the caller cannot silently recolor a paused map.
        frame.section.floor[0] = 0.025;
        expect(state.lastInput.section!.floor[0]).toBe(0.018);
        updateMusicFloor(world, input());
        expect(state.lastInput.section).toBeUndefined();
        expect(state.parameters.section).toEqual([0, 0, 0, 0]);
        expect(state.parameters.map).toEqual([1, 0, 0, 0]);
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
            progress: 0.7, strength: 1, mapRoll: 2, mapDrop: 10,
            floor: [0.009, 0.014, 0.026], line: [0.03, 0.064, 0.1], accent: [0.06, 0.17, 0.31],
        };
        updateMusicFloor(world, frame);
        const state = world.resource(MusicFloorState);
        expect(state.parameters.section).toEqual([0.7, 0, 1, 0]);
        expect(state.parameters.map).toEqual([1, 0, 0, 0]);
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

test("the shader's inverse coordinates keep the grid attached through a full floor turn", () => {
    for (const roll of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI * 2]) {
        const cosine = Math.cos(roll), sine = Math.sin(roll), drop = Math.sin(roll / 2) ** 2 * 22;
        for (const [x, y, z] of [[0, -0.15, 0], [18, -0.15, -18], [-7, -0.15, 12]]) {
            const projected = d.vec3f(x! * cosine - y! * sine, x! * sine + y! * cosine - drop, z!);
            const original = musicFloorCoordinates(d.vec4f(cosine, sine, drop, 0), projected);
            expect(original.x).toBeCloseTo(x!, 4);
            expect(original.y).toBeCloseTo(z!, 4);
        }
    }
});

test("the production floor function resolves its section uniforms into WGSL", () => {
    const source = musicFloorShaderSource();
    expect(source).toContain("@fragment fn floorFragment");
    expect(source).toContain("floorColor: vec4f");
    expect(source).toContain("accentColor: vec4f");
    expect(source).not.toContain("NaN");
});
