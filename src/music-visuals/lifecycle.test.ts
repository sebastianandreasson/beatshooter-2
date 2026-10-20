import { expect, test } from "bun:test";
import { createApp, MeshInstance } from "@dylanebert/shallot";
import { applySettings, Session } from "../session";
import { MusicVisuals, SampleMusicalVisuals } from "./index";
import { VisualEvents, type MusicEvent } from "./events";
import type { ParticlePool } from "./particles";

test("paused calibration clears old visual births without moving accepted time or combat", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    try {
        const { world } = app;
        const session = world.resource(Session);
        session.phase = "paused";
        session.position = session.visualPosition = 0.2;
        SampleMusicalVisuals.update!(world);
        const visuals = world.resource(MusicVisuals);
        const originalTimeline = visuals.timeline;
        const originalCombat = structuredClone(session.combat);
        const event: MusicEvent = {
            id: 1, kind: "kill", x: 1, z: 2, amount: 100, critical: false,
            simulationTime: 0.04, songTime: 0.04, visualTime: 0.04,
            generation: session.generation,
        };
        visuals.director.consume([event], true);
        visuals.director.step(0.2, true);
        expect(visuals.director.bursts).toHaveLength(1);
        expect(visuals.director.feedback).toHaveLength(1);
        world.resource(VisualEvents).pending.push({ ...event, id: 2 });
        const particle = world.create();
        world.add(particle, MeshInstance);
        visuals.pool = {
            visible: new Set([particle]), activeShards: 1, activeRings: 0,
        } as ParticlePool;

        applySettings(world, { timingOffsetMs: -250 });
        expect(session.position).toBe(0.2);
        expect(session.visualPosition).toBeCloseTo(-0.05);
        expect(session.combat).toEqual(originalCombat);
        SampleMusicalVisuals.update!(world);
        expect(visuals.timeline).toBe(originalTimeline);
        expect(visuals.frame.position).toBe(session.visualPosition);
        expect(visuals.director.bursts).toHaveLength(0);
        expect(visuals.director.pending).toHaveLength(0);
        expect(visuals.director.feedback).toHaveLength(0);
        expect(world.resource(VisualEvents).pending).toHaveLength(0);
        expect(visuals.pool.activeShards).toBe(0);
        expect(visuals.pool.visible.size).toBe(0);
        expect(world.has(particle, MeshInstance)).toBe(false);

        // Advancing back across the old birth cannot recreate a stale effect.
        visuals.director.step(0.2, true);
        expect(visuals.director.bursts).toHaveLength(0);
        const newEvent = { ...event, id: 3, songTime: 0.5, visualTime: 0.25 };
        visuals.director.consume([newEvent], false);
        expect(visuals.director.feedback).toHaveLength(1);
        const currentDirector = visuals.director;
        applySettings(world, { graphics: "low" });
        SampleMusicalVisuals.update!(world);
        expect(visuals.director).toBe(currentDirector);
        expect(visuals.director.feedback).toHaveLength(1);

        applySettings(world, { timingOffsetMs: 250 });
        SampleMusicalVisuals.update!(world);
        expect(session.visualPosition).toBeCloseTo(0.45);
        expect(session.position).toBe(0.2);
        expect(session.combat).toEqual(originalCombat);
        expect(visuals.director.feedback).toHaveLength(0);
    } finally {
        app.dispose();
    }
});
