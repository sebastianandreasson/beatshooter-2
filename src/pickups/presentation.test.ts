import { expect, spyOn, test } from "bun:test";
import { Body, createApp, Meshes, MeshInstance, Transform } from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { SampleMusicalVisuals } from "../music-visuals";
import { Session, SessionEntity } from "../session";
import { PickupPresentation, PickupsPlugin, PresentPickups } from "./index";
import { createPickups, startBomb } from "./state";

test("all pickup silhouettes and damaging rings remain visible with effects Off, freeze and clean up", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    const upload = spyOn(app.world.resource(Meshes), "add").mockReturnValue(0 as MeshHandle);
    try {
        const { world } = app;
        await PickupsPlugin.initialize!(world);
        const s = world.resource(Session), p = world.resource(PickupPresentation);
        s.phase = "playing";
        s.preferences.settings.effectsIntensity = "off";
        s.combat.pickups = createPickups(42, 60);
        s.combat.pickups.drops = s.combat.pickups.schedule.slice(0, 3);
        const bomb = s.combat.pickups.schedule.find(drop => drop.kind === "bomb")!;
        startBomb(s.combat.pickups, bomb, 18);
        s.combat.pickups.waves[0]!.radius = 5;
        SampleMusicalVisuals.update!(world);
        PresentPickups.update!(world);
        const pose = world.storage(Transform);
        expect(p.drops.size).toBe(3);
        expect(p.waves.size).toBe(1);
        for (const eid of [...p.drops.values()].flat().concat([...p.waves.values()])) {
            expect(world.has(eid, MeshInstance)).toBe(true);
            expect(world.has(eid, Body)).toBe(false);
            expect(pose.scale.x.get(eid)).toBeGreaterThan(0);
        }
        const wave = p.waves.get(bomb.id)!;
        expect(pose.scale.x.get(wave)).toBe(5);
        s.phase = "paused"; world.pause();
        for (let i = 0; i < 20; i++) PresentPickups.update!(world);
        expect(pose.scale.x.get(wave)).toBe(5);
        s.combat.pickups.drops.length = 0;
        s.combat.pickups.waves.length = 0;
        PresentPickups.update!(world);
        expect(p.drops.size).toBe(0);
        expect(p.waves.size).toBe(0);
        expect([...world.query([SessionEntity])]).toHaveLength(0);
        s.combat.pickups.drops = [bomb];
        PresentPickups.update!(world);
        for (const eid of [...world.query([SessionEntity])]) world.destroy(eid);
        s.generation++; s.combat.pickups = createPickups(7, 60);
        PresentPickups.update!(world);
        expect(p.drops.size).toBe(0);
        s.combat.pickups.drops = [bomb];
        PresentPickups.update!(world);
        s.phase = "results";
        PresentPickups.update!(world);
        expect([...world.query([SessionEntity])]).toHaveLength(0);
    } finally { upload.mockRestore(); app.dispose(); }
});
