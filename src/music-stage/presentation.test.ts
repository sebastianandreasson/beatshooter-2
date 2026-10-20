import { expect, test } from "bun:test";
import { Body, createApp, MeshInstance, Transform } from "@dylanebert/shallot";
import { MaterialPlugin } from "@dylanebert/shallot/standard/rendering";
import { Shape } from "@dylanebert/shallot/physics";
import { calculateEnergy } from "../analysis/energy";
import { MusicVisuals, SampleMusicalVisuals } from "../music-visuals";
import { SampleSectionEffects } from "../section-effects";
import { Session } from "../session";
import { DEMO_TRACK } from "../tracks";
import { createStagePool, MusicStage, PresentMusicStage, StageMaterial, STAGE_CAPACITY } from "./index";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [MaterialPlugin(StageMaterial)] });
    const { world } = app, session = world.resource(Session);
    const handle = world.resource(StageMaterial).add({ color: [0, 0, 0, 1], softness: 0 });
    const handles = Object.fromEntries(Object.keys(STAGE_CAPACITY).map(layer => [layer, handle])) as Parameters<typeof createStagePool>[1];
    createStagePool(world, handles);
    const state = world.resource(MusicStage);
    session.phase = "playing";
    session.track = DEMO_TRACK;
    const pcm = Float32Array.from({ length: 72 * 22050 }, (_, i) =>
        (Math.sin(i * 80 * Math.PI * 2 / 22050) + Math.sin(i * 800 * Math.PI * 2 / 22050)) * 0.2);
    session.loaded = {
        manifest: DEMO_TRACK, buffer: {} as AudioBuffer, structure: DEMO_TRACK.structure,
        energy: calculateEnergy(pcm), dispose() {},
    };
    Object.assign(session.preferences.settings, { effectsIntensity: "standard", reducedFlash: false, graphics: "high", timingOffsetMs: 0 });
    const render = (position: number) => {
        session.position = session.visualPosition = position;
        SampleMusicalVisuals.update!(world);
        SampleSectionEffects.update!(world);
        PresentMusicStage.update!(world);
    };
    const poses = () => Object.values(state.entities).flat().map(eid => world.get(eid, Transform));
    return { app, world, session, state, render, poses };
}

test("every layer runs from the song clock and fixed pools survive pause, seek and retry", async () => {
    const f = await fixture();
    try {
        const { state, render, poses, session, world } = f;
        const entities = Object.values(state.entities).flat();
        expect(entities.length).toBe(Object.values(STAGE_CAPACITY).reduce<number>((a, b) => a + b, 0));
        for (const eid of entities) {
            expect(world.has(eid, MeshInstance)).toBe(true);
            expect(world.has(eid, Body)).toBe(false);
            expect(world.has(eid, Shape)).toBe(false);
        }
        render(26.2);
        expect(Object.values(state.counts).every(count => count > 0)).toBe(true);
        expect(state.hasFeatures).toBe(true);
        const original = poses();
        session.phase = "paused";
        for (let i = 0; i < 20; i++) render(26.2);
        expect(poses()).toEqual(original);
        session.phase = "playing";
        render(41);
        expect(poses()).not.toEqual(original);
        render(26.2);
        expect(poses()).toEqual(original);
        session.generation++;
        render(0);
        expect(Object.values(state.entities).flat()).toEqual(entities);
        session.phase = "menu";
        render(0);
        expect(Object.values(state.counts).every(count => count === 0)).toBe(true);
        expect(poses().every(pose => pose!.scale.every(value => value === 0))).toBe(true);
    } finally { f.app.dispose(); }
});

test("section arrangements crossfade, audio controls intensity, and comfort/detail settings bound work", async () => {
    const f = await fixture();
    try {
        const { state, render, poses, session, world } = f;
        render(2);
        expect(state.counts.lasers).toBe(0);
        render(23.999);
        const before = state.frame!.arrangement;
        render(24);
        expect(state.frame!.arrangement.lasers).toBeCloseTo(before.lasers);
        render(26);
        expect(state.frame!.arrangement.lasers).toBe(1);
        const full = { ...state.counts }, fullGain = state.frame!.gain;
        session.preferences.settings.graphics = "low";
        render(26);
        expect(state.counts.lasers).toBe(full.lasers / 2);
        expect(state.counts.aurora).toBe(full.aurora / 2);
        expect(state.counts.geometry).toBe(full.geometry / 2);
        session.preferences.settings.effectsIntensity = "calm";
        render(26);
        expect(state.frame!.gain).toBeLessThan(fullGain);
        session.preferences.settings.reducedFlash = true;
        render(26);
        const still = poses();
        expect(state.counts.spectrum).toBe(64);
        expect(state.counts.lasers + state.counts.aurora + state.counts.echoes + state.counts.geometry).toBe(0);
        render(27);
        expect(poses()).toEqual(still);
        session.preferences.settings.effectsIntensity = "off";
        render(27);
        expect(Object.values(state.counts).every(count => count === 0)).toBe(true);
        session.preferences.settings.effectsIntensity = "standard";
        session.preferences.settings.reducedFlash = false;
        world.resource(MusicVisuals).osReducedMotion = true;
        render(27);
        expect(state.frame!.moving).toBe(false);
        world.resource(MusicVisuals).osReducedMotion = false;
        session.loaded!.energy = calculateEnergy(new Float32Array(72 * 22050));
        render(26);
        expect(state.frame!.energy).toBe(0);
        expect(Object.values(state.counts).every(count => count === 0)).toBe(true);
    } finally { f.app.dispose(); }
});
