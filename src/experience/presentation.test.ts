import { expect, spyOn, test } from "bun:test";
import { Body, createApp, Meshes, MeshInstance, Transform } from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { SampleMusicalVisuals } from "../music-visuals";
import { Session, SessionEntity } from "../session";
import { ExperiencePlugin, ExperiencePresentation, PresentExperience } from "./index";
import { createExperience, dropExperience } from "./state";

test("essential XP gems remain visible with effects off, freeze on pause, and clean up on collection and retry", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    const meshUpload = spyOn(app.world.resource(Meshes), "add").mockReturnValue(0 as MeshHandle);
    try {
        const { world } = app;
        await ExperiencePlugin.initialize!(world);
        const session = world.resource(Session), presentation = world.resource(ExperiencePresentation);
        session.phase = "playing";
        session.position = session.visualPosition = 0.2;
        const drop = dropExperience(session.combat.experience, { x: 2, z: 3 });
        SampleMusicalVisuals.update!(world);
        PresentExperience.update!(world);
        const eid = presentation.drops.get(drop.id)!;
        expect(presentation.drops.size).toBe(1);
        expect(world.has(eid, MeshInstance)).toBe(true);
        expect(world.has(eid, SessionEntity)).toBe(true);
        expect(world.has(eid, Body)).toBe(false);
        const pose = world.storage(Transform);
        const sample = () => [
            pose.translation.x.get(eid), pose.translation.y.get(eid), pose.translation.z.get(eid),
            pose.scale.x.get(eid), pose.rotation.y.get(eid), pose.rotation.w.get(eid),
        ];
        session.phase = "paused";
        world.pause();
        const held = sample();
        for (let render = 0; render < 20; render++) {
            SampleMusicalVisuals.update!(world);
            PresentExperience.update!(world);
            expect(sample()).toEqual(held);
        }
        session.preferences.settings.effectsIntensity = "off";
        SampleMusicalVisuals.update!(world);
        PresentExperience.update!(world);
        expect(world.has(eid, MeshInstance)).toBe(true);
        expect(pose.scale.x.get(eid)).toBeGreaterThan(0.2);
        const steady = sample();
        session.position = session.visualPosition = 0.4;
        SampleMusicalVisuals.update!(world);
        PresentExperience.update!(world);
        expect(sample()).toEqual(steady);
        session.preferences.settings.effectsIntensity = "standard";
        session.preferences.settings.reducedFlash = true;
        SampleMusicalVisuals.update!(world);
        PresentExperience.update!(world);
        expect(sample()).toEqual(steady);

        session.combat.experience.drops.length = 0;
        PresentExperience.update!(world);
        expect(presentation.drops.size).toBe(0);
        expect(world.has(eid, MeshInstance)).toBe(false);

        const oldDrop = dropExperience(session.combat.experience, { x: 5, z: 6 });
        PresentExperience.update!(world);
        const oldEntity = presentation.drops.get(oldDrop.id)!;
        // Reproduce the ownership boundary used by clearSession.
        for (const entity of [...world.query([SessionEntity])]) world.destroy(entity);
        session.combat.experience = createExperience();
        session.generation++;
        PresentExperience.update!(world);
        expect(presentation.drops.size).toBe(0);
        expect(world.has(oldEntity, MeshInstance)).toBe(false);
        dropExperience(session.combat.experience, { x: 1, z: 1 });
        PresentExperience.update!(world);
        expect(presentation.drops.size).toBe(1);
        session.phase = "results";
        PresentExperience.update!(world);
        expect(presentation.drops.size).toBe(0);
        expect([...world.query([SessionEntity])]).toHaveLength(0);
    } finally {
        meshUpload.mockRestore();
        app.dispose();
    }
});
