import { expect, test } from "bun:test";
import {
    Body, Camera, CameraMode, createApp, GlobalTransform, lookAtRotation, Materials, MeshInstance, StandardMaterial, Transform,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import { type View, Views, viewportToWorld, worldToViewport } from "@dylanebert/shallot/rendering";
import { deriveTransforms } from "@dylanebert/shallot/transform";
import type { SectionAnalysis } from "../analysis/sections";
import { Arena, box } from "../arena";
import { MusicVisuals, PresentMusicalVisuals, SampleMusicalVisuals } from "../music-visuals";
import { MusicFloorState, sectionShockwave } from "../music-visuals/floor";
import { generateTimeline } from "../rhythm/timeline";
import { SamplePlayer } from "../player";
import { planeIntersection } from "../player/movement";
import { Session } from "../session";
import { DEMO_TRACK } from "../tracks";
import { PresentSectionEffects, SampleSectionEffects, SectionEffects, SectionEffectsPlugin } from "./index";
import { SECTION_PALETTES } from "./state";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app;
    const arena = world.resource(Arena), materials = world.resource(Materials);
    arena.materials.floor = materials.add(StandardMaterial({ baseColor: [0.006, 0.012, 0.018, 1] }));
    arena.materials.line = materials.add(StandardMaterial({ baseColor: [0.03, 0.09, 0.105, 1] }));
    arena.materials.wall = materials.add(StandardMaterial({ baseColor: [0.07, 0.19, 0.21, 1] }));
    arena.camera = world.create();
    world.add(arena.camera, Camera, { mode: CameraMode.Orthographic, size: 17, clearColor: 0x090f15 });
    world.add(arena.camera, Transform, {
        translation: [0, 32, 19], rotation: lookAtRotation(0, 32, 19, 0, 0, 0),
    });
    arena.floor = box(world, arena.materials.floor, [0, -0.4, 0], [37, 0.5, 37]);
    arena.lines = [
        box(world, arena.materials.line, [6, -0.135, 0], [0.035, 0.025, 36]),
        box(world, arena.materials.line, [0, -0.135, -9], [36, 0.025, 0.035]),
    ];
    const wall = box(world, arena.materials.wall, [18.5, 0.2, 0], [1, 0.8, 38]);
    const actor = box(world, arena.materials.wall, [3, 0.55, -2], [1, 1, 1]);
    for (const eid of [wall, actor]) {
        world.add(eid, Body);
        world.add(eid, Shape);
    }
    const session = world.resource(Session);
    const structure: SectionAnalysis = {
        version: 1, analyzerVersion: "integration-fixture", duration: 12, elapsedMs: 0, backend: "wasm",
        sections: [
            { start: 0, end: 2, label: "intro" },
            { start: 2, end: 8, label: "chorus" },
            { start: 8, end: 12, label: "verse" },
        ],
    };
    session.track = { ...DEMO_TRACK, duration: 12, beats: generateTimeline(12, 120) };
    session.loaded = {
        manifest: session.track, structure, buffer: { duration: 12 } as AudioBuffer, dispose() {},
    };
    session.phase = "playing";
    Object.assign(session.preferences.settings, {
        effectsIntensity: "standard", graphics: "high", reducedFlash: false, timingOffsetMs: 0,
    });
    const state = world.resource(SectionEffects);
    await SectionEffectsPlugin.initialize!(world);
    const render = (position = session.position) => {
        session.position = position;
        session.visualPosition = position + session.preferences.settings.timingOffsetMs / 1000;
        SampleMusicalVisuals.update!(world);
        SampleSectionEffects.update!(world);
        PresentSectionEffects.update!(world);
        PresentMusicalVisuals.update!(world);
    };
    const poses = () => [...world.query([Transform])].map(eid => ({ eid, pose: world.get(eid, Transform) }));
    const camera = () => world.get(arena.camera, Camera)!;
    const wave = () => {
        const p = world.resource(MusicFloorState).parameters;
        return structuredClone({
            section: p.section, floor: p.floorColor, line: p.lineColor, accent: p.accentColor,
            fromFloor: p.fromFloor, fromLine: p.fromLine, fromAccent: p.fromAccent,
        });
    };
    return { app, world, arena, session, state, render, poses, camera, wave, wall, actor };
}

test("the color wave follows raw song time and freezes on pause without moving any camera or map entities", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, poses, camera, wave } = f;
        const originalCombat = structuredClone(session.combat);
        render(1);
        const originalPoses = poses(), originalSize = camera().size, originalBackground = camera().clearColor;
        render(2);
        const { startTime, endTime } = state.frame;
        const duration = endTime - startTime;
        render(startTime + duration * 0.1);
        expect(state.frame.progress).toBeCloseTo(0.1);
        expect(wave().fromFloor.slice(0, 3)).toEqual([...SECTION_PALETTES.intro.floor]);
        expect(wave().floor.slice(0, 3)).toEqual([...SECTION_PALETTES.chorus.floor]);
        expect(sectionShockwave(state.frame.waveProgress, state.strength, 0, 0.01).x).toBe(1);
        expect(sectionShockwave(state.frame.waveProgress, state.strength, 10, 0.01).x).toBe(0);
        const midpoint = startTime + duration * 0.5;
        render(midpoint);
        expect(state.frame.progress).toBeCloseTo(0.5);
        expect(sectionShockwave(state.frame.waveProgress, state.strength, 15, 0.01).y).toBeGreaterThan(0.8);
        expect(camera().clearColor).toBe(originalBackground);
        expect(camera().size).toBe(originalSize);
        expect(poses()).toEqual(originalPoses);

        const held = wave(), heldFrame = structuredClone(state.frame);
        session.phase = "paused";
        world.pause();
        for (let draw = 0; draw < 20; draw++) render();
        expect(wave()).toEqual(held);
        expect(state.frame).toEqual(heldFrame);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(world.resource(MusicVisuals).frame.position).toBeCloseTo(midpoint + 0.25);
        expect(state.frame).toEqual(heldFrame);
        expect(wave()).toEqual(held);
        expect(poses()).toEqual(originalPoses);

        session.phase = "playing";
        world.resume();
        render(startTime + duration * 0.75);
        expect(camera().clearColor).not.toBe(originalBackground);
        render(endTime);
        expect(state.frame.active).toBe(false);
        expect(state.strength).toBe(0);
        expect(state.frame.palette).toEqual(SECTION_PALETTES.chorus);
        expect(wave().floor.slice(0, 3)).toEqual([...SECTION_PALETTES.chorus.floor]);
        expect(world.resource(MusicFloorState).lastInput.section!.from).toBeUndefined();
        expect(poses()).toEqual(originalPoses);
        expect(camera().size).toBe(originalSize);
        expect(session.combat).toEqual(originalCombat);
    } finally {
        f.app.dispose();
    }
});

test("the lens anticipates a boundary, holds on pause and restores without drift when comfort settings or the run change", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, camera, poses } = f;
        render(1);
        const originalPoses = poses();
        render(1.75);
        expect(state.frame.anticipating).toBe(true);
        expect(state.frame.label).toBe("intro");
        expect(state.frame.palette).toEqual(SECTION_PALETTES.intro);
        expect(state.zoomScale).toBeGreaterThan(1);
        expect(state.zoomScale).toBeLessThan(1.05);
        expect(camera().size).toBeCloseTo(17 / state.zoomScale, 5);
        render(2);
        expect(state.zoomScale).toBeCloseTo(1.05, 8);
        expect(camera().size).toBeCloseTo(17 / 1.05, 5);
        render(2.125);
        const heldSize = camera().size, heldImpact = state.frame.impact;
        session.phase = "paused";
        world.pause();
        for (let frame = 0; frame < 60; frame++) render();
        expect(camera().size).toBe(heldSize);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(camera().size).toBe(heldSize);
        expect(state.frame.impact).toBe(heldImpact);
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(state.zoomScale).toBeCloseTo(1 + 0.01 * heldImpact, 8);
        expect(camera().size).toBeCloseTo(17 / state.zoomScale, 5);
        const disabled = [
            () => { session.preferences.settings.effectsIntensity = "off"; },
            () => {
                session.preferences.settings.effectsIntensity = "standard";
                world.resource(MusicVisuals).osReducedMotion = true;
            },
            () => {
                world.resource(MusicVisuals).osReducedMotion = false;
                session.preferences.settings.reducedFlash = true;
            },
        ];
        for (const change of disabled) {
            change();
            render();
            expect(state.zoomScale).toBe(1);
            expect(camera().size).toBe(17);
        }
        session.preferences.settings.reducedFlash = false;
        session.phase = "playing";
        world.resume();
        render(2.5);
        expect(state.zoomScale).toBe(1);
        expect(camera().size).toBe(17);
        render(8);
        expect(state.zoomScale).toBeCloseTo(1.05);
        session.phase = "menu";
        render();
        expect(camera().size).toBe(17);
        session.phase = "playing";
        render(8);
        session.generation++;
        render(0);
        expect(camera().size).toBe(17);
        expect(poses()).toEqual(originalPoses);
    } finally { f.app.dispose(); }
});

test("zoom uses each camera's captured base and restores both camera replacement and disposal", async () => {
    const f = await fixture();
    const cameras = f.world.storage(Camera);
    try {
        const original = f.arena.camera;
        cameras.size.set(original, 19);
        f.render(2);
        expect(f.state.baseCameraSize).toBe(19);
        expect(cameras.size.get(original)).toBeCloseTo(19 / 1.05, 5);
        const replacement = f.world.create();
        f.world.add(replacement, Camera, { mode: CameraMode.Orthographic, size: 21 });
        f.arena.camera = replacement;
        f.render();
        expect(cameras.size.get(original)).toBe(19);
        expect(f.state.baseCameraSize).toBe(21);
        expect(cameras.size.get(replacement)).toBeCloseTo(21 / 1.05, 5);
        f.app.dispose();
        expect(cameras.size.get(replacement)).toBe(21);
        expect(f.state.zoomScale).toBe(1);
        expect(f.state.zoomCamera).toBeUndefined();
    } finally { f.app.dispose(); }
});

test("aim rays and projected actor labels use the same zoomed lens before player input", async () => {
    const f = await fixture();
    try {
        const { world, arena, render, state } = f;
        // This GPU-free fixture does not install TransformPlugin or renderer
        // component defaults; provide the real camera placement/projection here.
        world.add(arena.camera, GlobalTransform);
        world.storage(Transform).scale.set(arena.camera, 1, 1, 1);
        world.storage(Camera).near.set(arena.camera, 0.1);
        world.storage(Camera).far.set(arena.camera, 160);
        world.resource(Views).set(arena.camera, {
            camera: world.ref(arena.camera), canvas: null, context: null,
            texture: { width: 1280, height: 800, destroy() {} },
        } as unknown as View);
        deriveTransforms(world);
        expect(SampleSectionEffects.before).toContain(SamplePlayer);
        render(1);
        const baseline = worldToViewport(world, arena.camera, [3, 0.55, -2])!;
        for (const time of [1.75, 2, 2.25, 2.5]) {
            render(time);
            for (const height of [0.55, 1.8, 2.45]) {
                const pixel = worldToViewport(world, arena.camera, [3, height, -2]);
                expect(pixel).not.toBeNull();
                const ray = viewportToWorld(world, arena.camera, pixel![0], pixel![1]);
                expect(ray).not.toBeNull();
                const target = planeIntersection(ray!.origin, ray!.dir, height);
                expect(target!.x).toBeCloseTo(3, 4);
                expect(target!.z).toBeCloseTo(-2, 4);
                if (height === 0.55) {
                    expect((pixel![0] - 640) / (baseline[0] - 640)).toBeCloseTo(state.zoomScale, 5);
                }
            }
        }
    } finally { f.app.dispose(); }
});

test("Calm softens the one wave, while Off and reduced motion use a stationary palette fade", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, poses, wave } = f;
        render(2);
        render((state.frame.startTime + state.frame.endTime) / 2);
        const standardStrength = state.strength, originalPoses = poses();
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(state.strength).toBeGreaterThan(0);
        expect(state.strength).toBeLessThan(standardStrength);
        expect(poses()).toEqual(originalPoses);
        const checks: Array<() => void> = [
            () => { session.preferences.settings.effectsIntensity = "off"; },
            () => {
                session.preferences.settings.effectsIntensity = "standard";
                world.resource(MusicVisuals).osReducedMotion = true;
            },
            () => {
                world.resource(MusicVisuals).osReducedMotion = false;
                session.preferences.settings.reducedFlash = true;
            },
        ];
        for (const change of checks) {
            change();
            render();
            expect(state.strength).toBe(0);
            expect(wave().section[1]).toBe(0);
            expect(wave().floor.slice(0, 3)).toEqual([...state.frame.palette.floor]);
            expect(world.resource(MusicFloorState).lastInput.section!.from).toBeUndefined();
            expect(poses()).toEqual(originalPoses);
            expect(f.camera().size).toBe(17);
        }
        session.preferences.settings.reducedFlash = false;
        session.preferences.settings.graphics = "low";
        render();
        expect(state.strength).toBe(standardStrength);
        expect(world.resource(MusicFloorState).parameters.response[2]).toBe(0);
        expect(sectionShockwave(state.frame.waveProgress, state.strength, 15, 0.01).y).toBeGreaterThan(0.8);
        expect(poses()).toEqual(originalPoses);
    } finally {
        f.app.dispose();
    }
});

test("retry, menu and track replacement clear the wave and restore colors without creating any entities", async () => {
    const f = await fixture();
    try {
        const { world, session, state, arena, render, poses } = f;
        render(0);
        const baseline = poses();
        for (let retry = 0; retry < 5; retry++) {
            render(3);
            expect(state.strength).toBeGreaterThan(0);
            const oldTimeline = state.timeline;
            session.generation++;
            render(0);
            expect(state.timeline).not.toBe(oldTimeline);
            expect(state.strength).toBe(0);
            expect(poses()).toEqual(baseline);
        }
        render(8.8);
        expect(state.strength).toBeGreaterThan(0);
        session.phase = "menu";
        render();
        expect(state.frame.index).toBe(-1);
        expect(state.strength).toBe(0);
        expect(f.camera().clearColor).toBe(0x090f15);
        expect(poses()).toEqual(baseline);
        expect(world.resource(MusicFloorState).lastInput.section).toBeUndefined();
        expect(world.resource(Materials).get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.07);
        session.phase = "playing";
        session.track = { ...session.track, id: "replacement-no-analysis" };
        session.loaded = undefined;
        render(3);
        expect(state.frame.index).toBe(-1);
        expect(state.strength).toBe(0);
        expect(poses()).toEqual(baseline);
        expect([...world.query([MeshInstance])]).toHaveLength(5);
        expect([...world.query([Body])]).toEqual([f.wall, f.actor]);
        expect([...world.query([Shape])]).toEqual([f.wall, f.actor]);
    } finally {
        f.app.dispose();
    }
});
