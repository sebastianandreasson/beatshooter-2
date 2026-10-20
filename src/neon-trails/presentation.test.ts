import { expect, test } from "bun:test";
import { Body, createApp, MeshInstance, MeshMaterial, Transform } from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import { AlphaModeCode } from "@dylanebert/shallot/standard/rendering";
import { PLAYER_COLLISION_GROUP, type Projectile } from "../combat";
import { MusicVisuals, SampleMusicalVisuals } from "../music-visuals";
import { Presentation, PresentationPlugin } from "../presentation";
import { generateTimeline } from "../rhythm/timeline";
import { Session, SessionEntity } from "../session";
import { DEMO_TRACK } from "../tracks";
import { createNeonTrailPool, NeonTrails, PresentNeonTrails } from "./index";
import { LOW_TRAIL_CAPACITY, TRAIL_CAPACITY } from "./pose";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app, session = world.resource(Session);
    createNeonTrailPool(world);
    const state = world.resource(NeonTrails), presentation = world.resource(Presentation);
    session.phase = "playing";
    session.track = { ...DEMO_TRACK, duration: 12, beats: generateTimeline(12, 120) };
    Object.assign(session.preferences.settings, {
        graphics: "high", effectsIntensity: "standard", reducedFlash: false, timingOffsetMs: 0,
    });
    const shot = (id: number, hostile = false, x = 4, age = 0.2): Projectile => {
        const projectile: Projectile = {
            id, shooterId: 0, collisionMask: hostile ? PLAYER_COLLISION_GROUP : 2,
            x, z: 2, previousX: x - 0.3, previousZ: 2, velocityX: hostile ? 9 : 32, velocityZ: 0,
            remainingLifetime: (hostile ? session.combat.tuning.enemyProjectileLifetime : session.combat.tuning.projectileLifetime) - age,
            radius: 0.13, damage: 10, initialDamage: 10, critical: false, bouncesRemaining: 1,
            wallBouncesRemaining: 0, homingTurnRemaining: 0,
            hitEnemyIds: [], waitingForBounce: false, lastBounceBeat: 0,
        };
        const eid = world.create();
        world.add(eid, Transform, { translation: [x - 0.15, 0.55, 2] });
        world.add(eid, MeshInstance);
        world.add(eid, MeshMaterial, state.playerMaterial!);
        presentation.projectiles.set(id, eid);
        session.combat.projectiles.push(projectile);
        return projectile;
    };
    const render = (position = session.position) => {
        session.position = position;
        session.visualPosition = position + session.preferences.settings.timingOffsetMs / 1000;
        SampleMusicalVisuals.update!(world);
        PresentNeonTrails.update!(world);
    };
    const poses = () => state.entities.slice(0, state.visibleCount).map(eid => world.get(eid, Transform));
    return { app, world, session, state, presentation, shot, render, poses };
}

test("a bounded cosmetic pool follows interpolated heads, grows on music time, and freezes through pause and calibration", async () => {
    const f = await fixture();
    try {
        const { world, state, session, shot, render, poses, presentation } = f;
        const projectile = shot(1, false, 4, 0);
        const core = presentation.projectiles.get(1)!;
        const coreBefore = world.get(core, Transform), shotBefore = structuredClone(projectile);
        const entities = [...state.entities];
        expect(entities).toHaveLength(TRAIL_CAPACITY);
        expect(PresentNeonTrails.after).toEqual(PresentationPlugin.systems);
        render(1);
        expect(state.visibleCount).toBe(0);
        render(1.02);
        expect(state.visibleCount).toBe(1);
        const young = state.witnesses[0]!.length;
        render(1.06);
        expect(state.witnesses[0]!.length).toBeGreaterThan(young);
        expect(state.witnesses[0]!.x + state.witnesses[0]!.length / 2).toBeCloseTo(3.85 - 0.23);
        const held = poses(), witness = structuredClone(state.witnesses);
        session.phase = "paused";
        world.pause();
        // The core presentation may settle its fixed-step interpolation on pause.
        // Trail presentation retains its accepted pose at the held music position.
        world.storage(Transform).translation.x.set(core, 4);
        for (let i = 0; i < 20; i++) render();
        expect(poses()).toEqual(held);
        expect(state.witnesses).toEqual(witness);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(poses()).toEqual(held);
        expect(state.witnesses).toEqual(witness);
        expect(projectile).toEqual(shotBefore);
        expect(coreBefore!.translation).toEqual([Math.fround(3.85), Math.fround(0.55), 2]);
        expect(state.entities).toEqual(entities);
        for (const eid of entities) {
            expect(world.has(eid, Body)).toBe(false);
            expect(world.has(eid, Shape)).toBe(false);
            expect(world.has(eid, SessionEntity)).toBe(false);
        }
        expect(world.get(entities[0]!, MeshMaterial)!.alphaMode).toBe(AlphaModeCode.Blend);
    } finally { f.app.dispose(); }
});

test("low graphics prioritizes nearby hostile shots, Calm shortens tails, and shot churn never allocates pool entities", async () => {
    const f = await fixture();
    try {
        const { state, session, shot, render, world } = f;
        for (let i = 0; i < 240; i++) shot(i + 1, i >= 120, (i % 120) / 8);
        render(1);
        expect(state.visibleCount).toBe(TRAIL_CAPACITY);
        expect(state.births.size).toBe(TRAIL_CAPACITY);
        const pool = [...state.entities], highWater = world.entityHighWater;
        session.preferences.settings.graphics = "low";
        render();
        expect(state.visibleCount).toBe(LOW_TRAIL_CAPACITY);
        expect(state.witnesses.every(witness => witness.hostile)).toBe(true);
        expect(state.witnesses.map(witness => witness.projectileId)).toEqual([121, 122, 123]);
        const length = state.witnesses[0]!.length;
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(state.witnesses[0]!.length).toBeLessThan(length);
        expect(state.births.size).toBe(LOW_TRAIL_CAPACITY);
        for (let i = 0; i < 12; i++) {
            session.combat.projectiles.splice(0, 3);
            render(1 + i / 100);
        }
        expect(state.entities).toEqual(pool);
        expect(world.entityHighWater).toBe(highWater);
        expect(state.visibleCount).toBeLessThanOrEqual(LOW_TRAIL_CAPACITY);
    } finally { f.app.dispose(); }
});

test("bounce waits, comfort settings, menu and retry clear live tails without affecting projectiles", async () => {
    const f = await fixture();
    try {
        const { world, state, session, shot, render } = f;
        const projectile = shot(1);
        render(1);
        expect(state.visibleCount).toBe(1);
        projectile.waitingForBounce = true;
        render(1.1);
        expect(state.visibleCount).toBe(0);
        expect(state.births.size).toBe(0);
        projectile.waitingForBounce = false;
        projectile.lastBounceBeat++;
        projectile.remainingLifetime = session.combat.tuning.projectileLifetime;
        projectile.velocityX = 0; projectile.velocityZ = -32;
        render(1.5);
        expect(state.visibleCount).toBe(0);
        render(1.54);
        expect(state.visibleCount).toBe(1);
        expect(state.witnesses[0]!.yaw).toBeCloseTo(Math.PI);
        const settings = session.preferences.settings;
        const disable = [
            () => { settings.effectsIntensity = "off"; },
            () => { settings.effectsIntensity = "standard"; settings.reducedFlash = true; },
            () => { settings.reducedFlash = false; world.resource(MusicVisuals).osReducedMotion = true; },
        ];
        for (const change of disable) {
            change(); render(1.6);
            expect(state.visibleCount).toBe(0);
            expect(state.entities.some(eid => world.has(eid, MeshInstance))).toBe(false);
            expect(session.combat.projectiles).toEqual([projectile]);
        }
        world.resource(MusicVisuals).osReducedMotion = false;
        projectile.remainingLifetime -= 0.2;
        render(1.8);
        expect(state.visibleCount).toBe(1);
        session.phase = "menu"; render();
        expect(state.visibleCount).toBe(0);
        expect(state.witnesses).toHaveLength(0);
        session.phase = "playing"; session.generation++;
        session.combat.projectiles.length = 0;
        render(0);
        expect(state.visibleCount).toBe(0);
        expect(state.births.size).toBe(0);
        expect(state.entities).toHaveLength(TRAIL_CAPACITY);
    } finally { f.app.dispose(); }
});
