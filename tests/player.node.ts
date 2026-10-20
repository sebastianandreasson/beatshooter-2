import { expect, test } from "bun:test";
import { Body, BodyType, createApp, GlobalTransform, StandardPhysicsPlugin, Transform, type Plugin } from "@dylanebert/shallot";
import { Shape, ShapeKind } from "@dylanebert/shallot/physics";
import { PhysicsWorldDefinition } from "@dylanebert/shallot/standard/physics";
import { MovePlayer, PLANAR_LOCKS, PlayerState, resetPlayer, SnapshotPlayer } from "../src/player";

const fixture: Plugin = {
    name: "PlayerFixture", recovery: "stateless", deterministic: false,
    systems: [MovePlayer, SnapshotPlayer],
    initialize(world) {
        world.resource(PhysicsWorldDefinition).gravity = { x: 0, y: 0, z: 0 };
        const state = world.resource(PlayerState);
        state.enabled = true;
        state.body = world.create();
        world.add(state.body, Transform, { translation: [0, 0.55, 0] });
        world.add(state.body, Body, { type: BodyType.Dynamic, motionLocks: PLANAR_LOCKS, enableSleep: 0 });
        world.add(state.body, Shape, { kind: ShapeKind.Sphere, radius: 0.55 });
    },
};

test("real Shallot fixed physics keeps movement planar, normalizes diagonals, resets velocity", async () => {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin, fixture] });
    try {
        const { world } = app, state = world.resource(PlayerState);
        state.input = { x: 1, z: 1 };
        for (let i = 0; i < 120; i++) world.step(1 / 60);
        expect(state.position.x).toBeGreaterThan(9);
        expect(state.position.x).toBeCloseTo(state.position.z, 4);
        const velocity = world.storage(GlobalTransform).linearVelocity;
        expect(Math.hypot(velocity.x.get(state.body), velocity.z.get(state.body))).toBeCloseTo(8, 2);
        expect(world.storage(GlobalTransform).translation.y.get(state.body)).toBeCloseTo(0.55, 5);
        resetPlayer(world);
        world.step(1 / 60);
        expect(state.position.x).toBeCloseTo(0, 6);
        expect(state.position.z).toBeCloseTo(0, 6);
        expect(velocity.x.get(state.body)).toBeCloseTo(0, 6);
    } finally { app.dispose(); }
});
