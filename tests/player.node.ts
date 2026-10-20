import { expect, test } from "bun:test";
import { Body, BodyType, createApp, GlobalTransform, setTransform, StandardPhysicsPlugin, Transform, type Plugin } from "@dylanebert/shallot";
import { Shape, ShapeKind } from "@dylanebert/shallot/physics";
import { PhysicsWorldDefinition } from "@dylanebert/shallot/standard/physics";
import { MovePlayer, PLANAR_LOCKS, PlayerState, resetPlayer, SnapshotPlayer } from "../src/player";
import { PLAYER_SPEED } from "../src/player/movement";
import { DASH_DISTANCE, DashController } from "../src/dash/state";
import { createDashTiming } from "../src/dash/timing";
import { generateTimeline } from "../src/rhythm/timeline";
import { MAX_DASH_DISTANCE } from "../src/player-stats";

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

for (const distance of [DASH_DISTANCE, MAX_DASH_DISTANCE]) {
test(`real physics ${distance}-unit dash reaches the arena corner without crossing walls or leaving the play plane`, async () => {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin, fixture] });
    try {
        const { world } = app, state = world.resource(PlayerState);
        const shapes = world.storage(Shape);
        shapes.friction.set(state.body, 0);
        shapes.filterCategoryLow.set(state.body, 1);
        shapes.filterMaskLow.set(state.body, 6);
        shapes.filterCategoryHigh.set(state.body, 0);
        shapes.filterMaskHigh.set(state.body, 0);
        // Match the playable arena's wall geometry and collision masks.
        for (const [x, z, sx, sz] of [[18.5, 0, 1, 38], [0, 18.5, 38, 1]]) {
            const wall = world.create();
            world.add(wall, Transform, { translation: [x!, 0.2, z!], scale: [sx!, 0.8, sz!] });
            world.add(wall, Body);
            world.add(wall, Shape, {
                filterCategoryLow: 4, filterMaskLow: 3,
                filterCategoryHigh: 0, filterMaskHigh: 0, friction: 0,
            });
        }
        world.step(1 / 60);
        setTransform(world, state.body, [16.5, 0.55, 16.5], [0, 0, 0, 1]);
        world.step(1 / 60);
        const dash = new DashController(createDashTiming(generateTimeline(5, 300)));
        expect(dash.press(0, { x: 1, z: 1 }, { x: 0, z: -1 }, state.position, distance)).toBe(true);
        const velocity = world.storage(GlobalTransform).linearVelocity;
        const translation = world.storage(GlobalTransform).translation;
        for (let frame = 0; frame < 20; frame++) {
            dash.update(frame / 60);
            const active = dash.active;
            state.dashVelocity = active ? {
                x: active.direction.x * active.speed, z: active.direction.z * active.speed,
            } : undefined;
            const progress = active ? (frame / 60) / (active.endsAt - active.startedAt) : 0;
            state.dashTarget = active ? {
                x: active.origin.x + active.direction.x * active.distance * progress,
                z: active.origin.z + active.direction.z * active.distance * progress,
            } : undefined;
            world.step(1 / 60);
            expect(state.position.x).toBeLessThanOrEqual(17.5);
            expect(state.position.z).toBeLessThanOrEqual(17.5);
            expect(translation.y.get(state.body)).toBeCloseTo(0.55, 5);
            expect(velocity.y.get(state.body)).toBeCloseTo(0, 5);
        }
        expect(state.position.x).toBeGreaterThan(17.2);
        expect(state.position.z).toBeGreaterThan(17.2);
        expect(Math.abs(state.position.x - state.position.z)).toBeLessThan(0.05);
        expect(Math.hypot(velocity.x.get(state.body), velocity.z.get(state.body))).toBeLessThan(0.01);
        expect(state.wasDashing).toBe(false);
    } finally { app.dispose(); }
});
}

test("a real physics dash ends at normal movement speed and reset removes an active override", async () => {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin, fixture] });
    try {
        const { world } = app, state = world.resource(PlayerState);
        world.step(1 / 60); // Publish the newly created physics body before accepting input.
        const dash = new DashController(createDashTiming(generateTimeline(5, 120)));
        expect(dash.press(0, { x: 1, z: 0 }, { x: 0, z: -1 })).toBe(true);
        const active = dash.active!;
        const velocity = world.storage(GlobalTransform).linearVelocity;
        for (let frame = 0; frame / 60 < active.endsAt; frame++) {
            state.dashVelocity = { x: active.speed, z: 0 };
            state.dashTarget = { x: DASH_DISTANCE * (frame / 60) / (active.endsAt - active.startedAt), z: 0 };
            world.step(1 / 60);
        }
        // 3.6 is the nominal maximum target. The music envelope may end one
        // presentation sample short, without adding late movement to compensate.
        expect(state.position.x).toBeGreaterThanOrEqual(DASH_DISTANCE - active.speed / 60 - 0.01);
        expect(state.position.x).toBeLessThanOrEqual(DASH_DISTANCE + 0.01);
        expect(velocity.x.get(state.body)).toBeGreaterThan(PLAYER_SPEED * 3);
        state.dashVelocity = undefined;
        state.dashTarget = undefined;
        state.input = { x: 1, z: 0 };
        world.step(1 / 60);
        expect(state.wasDashing).toBe(false);
        expect(velocity.x.get(state.body)).toBeGreaterThan(0);
        expect(velocity.x.get(state.body)).toBeLessThanOrEqual(PLAYER_SPEED);
        for (let frame = 0; frame < 60; frame++) world.step(1 / 60);
        expect(velocity.x.get(state.body)).toBeCloseTo(PLAYER_SPEED, 3);
        expect(world.storage(GlobalTransform).translation.y.get(state.body)).toBeCloseTo(0.55, 5);
        state.dashVelocity = { x: 45, z: 0 };
        state.dashTarget = { x: state.position.x + 1, z: state.position.z };
        world.step(1 / 60);
        expect(state.wasDashing).toBe(true);
        resetPlayer(world);
        expect(state.dashVelocity).toBeUndefined();
        expect(state.dashTarget).toBeUndefined();
        expect(state.wasDashing).toBe(false);
        world.step(1 / 60);
        expect(state.position).toEqual({ x: 0, z: 0 });
        expect(velocity.x.get(state.body)).toBeCloseTo(0, 6);
        expect(velocity.z.get(state.body)).toBeCloseTo(0, 6);
    } finally { app.dispose(); }
});

test("held music-time dash targets stop real fixed physics from adding distance during resume lead-in", async () => {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin, fixture] });
    try {
        const { world } = app, state = world.resource(PlayerState);
        world.step(1 / 60);
        const direction = { x: 0.6, z: 0.8 };
        state.dashVelocity = { x: direction.x * 28.8, z: direction.z * 28.8 };
        const velocity = world.storage(GlobalTransform).linearVelocity;
        // These are three successive absolute targets on one dash's musical path.
        // Arbitrarily many fixed updates between song-clock samples must not overshoot.
        for (const distance of [1.2, 2.4, DASH_DISTANCE]) {
            state.dashTarget = { x: direction.x * distance, z: direction.z * distance };
            for (let frame = 0; frame < 90; frame++) {
                world.step(1 / 60);
                expect(Math.hypot(state.position.x, state.position.z)).toBeLessThanOrEqual(distance + 0.001);
                expect(world.storage(GlobalTransform).translation.y.get(state.body)).toBeCloseTo(0.55, 5);
            }
            expect(state.position.x).toBeCloseTo(state.dashTarget.x, 5);
            expect(state.position.z).toBeCloseTo(state.dashTarget.z, 5);
            expect(Math.hypot(velocity.x.get(state.body), velocity.z.get(state.body))).toBeLessThan(0.001);
        }
        state.dashTarget = undefined;
        state.dashVelocity = undefined;
        world.step(1 / 60);
        expect(state.wasDashing).toBe(false);
        expect(Math.hypot(velocity.x.get(state.body), velocity.z.get(state.body))).toBeLessThan(0.001);
    } finally { app.dispose(); }
});
