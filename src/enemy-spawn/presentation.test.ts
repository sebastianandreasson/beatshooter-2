import { expect, test } from "bun:test";
import { Body, createApp, Materials, MeshInstance, StandardMaterial, Transform } from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import { Arena } from "../arena";
import { createEnemy, type EnemyKind } from "../enemies";
import { SampleMusicalVisuals } from "../music-visuals";
import { Session, SessionEntity } from "../session";
import { EnemySpawnPlugin, EnemySpawnPresentation, PresentEnemySpawns } from "./index";

test("pending arrivals are cosmetic only, freeze on pause, ignore calibration and clean up with the session", async () => {
    const app = await createApp({ defaults: false, plugins: [] });
    try {
        const { world } = app;
        const material = world.resource(Materials).add(StandardMaterial({ baseColor: [0.5, 0.2, 0.2, 1] }));
        const arena = world.resource(Arena);
        arena.materials.enemy = arena.materials.spinner = arena.materials.ranger = material;
        await EnemySpawnPlugin.initialize!(world);
        const session = world.resource(Session), state = world.resource(EnemySpawnPresentation);
        session.phase = "playing";
        session.position = session.visualPosition = 0.2;
        for (const [index, kind] of (["chaser", "spinner", "ranger"] as EnemyKind[]).entries()) {
            session.combat.pendingSpawns.push({
                enemy: createEnemy(index + 1, { x: index * 3, z: 6 }, 0, session.combat.tuning, kind),
                startTime: 0, endTime: 0.5, activateBeat: 1,
            });
        }
        const render = () => {
            SampleMusicalVisuals.update!(world);
            PresentEnemySpawns.update!(world);
        };
        render();
        expect(state.spawns.size).toBe(3);
        expect(session.combat.enemies).toHaveLength(0);
        expect(session.enemyBodies.size).toBe(0);
        expect(state.spawns.get(1)!.accents).toHaveLength(0);
        expect(state.spawns.get(2)!.accents).toHaveLength(3);
        expect(state.spawns.get(3)!.accents).toHaveLength(3);
        for (const spawn of state.spawns.values()) {
            expect(spawn.beams).toHaveLength(5);
            expect(world.storage(Transform).scale.x.get(spawn.beams[4]!)).toBeGreaterThan(1);
        }
        const all = () => [...state.spawns.values()].flatMap(spawn =>
            [spawn.body, ...spawn.accents, ...spawn.beams, ...spawn.outline]);
        for (const eid of all()) {
            expect(world.has(eid, SessionEntity)).toBe(true);
            expect(world.has(eid, MeshInstance)).toBe(true);
            expect(world.has(eid, Body)).toBe(false);
            expect(world.has(eid, Shape)).toBe(false);
        }
        const transform = world.storage(Transform);
        const poses = () => all().map(eid => [
            transform.translation.x.get(eid), transform.translation.y.get(eid), transform.translation.z.get(eid),
            transform.scale.x.get(eid), transform.scale.y.get(eid), transform.scale.z.get(eid),
            transform.rotation.y.get(eid), transform.rotation.w.get(eid),
        ]);
        const held = poses();
        session.phase = "paused";
        world.pause();
        for (let renderIndex = 0; renderIndex < 20; renderIndex++) {
            render();
            expect(poses()).toEqual(held);
        }
        session.visualPosition = 0.45;
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(poses()).toEqual(held);

        session.preferences.settings.effectsIntensity = "off";
        render();
        for (const spawn of state.spawns.values()) {
            expect(transform.translation.y.get(spawn.body)).toBeCloseTo(0.55);
            expect(transform.scale.x.get(spawn.body)).toBeGreaterThan(0);
            for (const beam of spawn.beams) expect(transform.scale.x.get(beam)).toBe(0);
            for (const edge of spawn.outline) expect(transform.scale.z.get(edge)).toBeGreaterThan(0);
        }
        const beforeGrowth = transform.scale.x.get(state.spawns.get(1)!.body);
        session.position = 0.4;
        render();
        expect(transform.scale.x.get(state.spawns.get(1)!.body)).toBeGreaterThan(beforeGrowth);

        // Combat activation removes only this preview; the live body is owned
        // separately by PrepareCombat and is never transformed by this plugin.
        const activated = session.combat.pendingSpawns.shift()!;
        const formerBody = state.spawns.get(activated.enemy.id)!.body;
        session.combat.enemies.push(activated.enemy);
        render();
        expect(state.spawns.has(activated.enemy.id)).toBe(false);
        expect(world.has(formerBody, MeshInstance)).toBe(false);
        expect(state.spawns.size).toBe(2);

        const oldEntities = all();
        for (const eid of [...world.query([SessionEntity])]) world.destroy(eid);
        session.combat.pendingSpawns.length = 0;
        session.generation++;
        render();
        expect(state.spawns.size).toBe(0);
        for (const eid of oldEntities) expect(world.has(eid, MeshInstance)).toBe(false);
        session.combat.pendingSpawns.push({ ...activated, startTime: 0.5, endTime: 1, activateBeat: 2 });
        render();
        expect(state.spawns.size).toBe(1);
        session.phase = "results";
        render();
        expect(state.spawns.size).toBe(0);
        expect([...world.query([SessionEntity])]).toHaveLength(0);
    } finally {
        app.dispose();
    }
});
