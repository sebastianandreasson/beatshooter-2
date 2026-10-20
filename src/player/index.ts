import {
    Body, BodyMotionLock, BodyType, component, GlobalTransform, lookAtRotation,
    setLinearVelocity, setTransform, StandardPhysicsPlugin, StepPhysicsSystem,
    Transform, type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import { Shape, ShapeKind } from "@dylanebert/shallot/physics";
import { PhysicsWorldDefinition } from "@dylanebert/shallot/standard/physics";
import { viewportToWorld } from "@dylanebert/shallot/rendering";
import { Arena } from "../arena";
import { aimDirection, movementVelocity, planeIntersection, type Planar } from "./movement";
import { createPlayerShip, type PlayerShip } from "./ship";
import type { ShipEngineFrame } from "./engine";

export const Player = component("Beatshooter/Player", {});
export const PLANAR_LOCKS = BodyMotionLock.linearY | BodyMotionLock.angularX | BodyMotionLock.angularY | BodyMotionLock.angularZ;
export const PlayerState: Resource<{
    body: number; ship: number; nose: number; wings: number[]; enabled: boolean;
    visual?: PlayerShip; engine?: ShipEngineFrame;
    input: Planar; aim: Planar; target: Planar; previous: Planar; position: Planar;
    pointer: { x: number; y: number; active: boolean }; keys: Set<string>;
    dashVelocity?: Planar; dashTarget?: Planar; wasDashing: boolean;
}> = { create: () => ({
    body: -1, ship: -1, nose: -1, wings: [], enabled: false,
    input: { x: 0, z: 0 }, aim: { x: 0, z: -1 }, target: { x: 0, z: -4 },
    previous: { x: 0, z: 0 }, position: { x: 0, z: 0 },
    pointer: { x: 0, y: 0, active: false }, keys: new Set(), wasDashing: false,
}) };

export function resetPlayer(world: World): void {
    const player = world.resource(PlayerState);
    setTransform(world, player.body, [0, 0.55, 0], [0, 0, 0, 1]);
    setLinearVelocity(world, player.body, { x: 0, y: 0, z: 0 });
    world.storage(Body).linearVelocity.set(player.body, 0, 0, 0);
    player.previous = player.position = { x: 0, z: 0 };
    player.aim = { x: 0, z: -1 };
    player.target = { x: 0, z: -4 };
    player.input = { x: 0, z: 0 };
    player.keys.clear();
    player.dashVelocity = undefined;
    player.dashTarget = undefined;
    player.wasDashing = false;
    player.engine = undefined;
    for (const thruster of player.visual?.thrusters ?? []) {
        world.storage(Transform).scale.set(thruster.plume, 0, 0, 0);
        world.storage(Transform).scale.set(thruster.core, 0, 0, 0);
    }
}

export function readMovementInput(keys: ReadonlySet<string>): Planar {
    const pressed = (a: string, b: string) => Number(keys.has(a) || keys.has(b));
    return { x: pressed("KeyD", "ArrowRight") - pressed("KeyA", "ArrowLeft"),
        z: pressed("KeyS", "ArrowDown") - pressed("KeyW", "ArrowUp") };
}

export function sampleAim(world: World): void {
    const player = world.resource(PlayerState);
    const canvas = typeof document !== "undefined" ? document.querySelector("canvas") : null;
    if (!canvas || !player.pointer.active) return;
    const bounds = canvas.getBoundingClientRect();
    const ray = viewportToWorld(world, world.resource(Arena).camera, player.pointer.x - bounds.left, player.pointer.y - bounds.top);
    const target = ray && planeIntersection(ray.origin, ray.dir);
    if (target) {
        player.target = target;
        player.aim = aimDirection(player.position, target, player.aim);
    }
}

export const SamplePlayer: System = {
    name: "Beatshooter/SampleInput", group: "setup",
    update(world) {
        const player = world.resource(PlayerState);
        player.input = player.enabled ? readMovementInput(player.keys) : { x: 0, z: 0 };
        sampleAim(world);
    },
};

export const MovePlayer: System = {
    name: "Beatshooter/MovePlayer", group: "fixed", before: [StepPhysicsSystem],
    update(world) {
        const player = world.resource(PlayerState);
        if (!player.enabled) return;
        const velocity = world.storage(GlobalTransform).linearVelocity;
        // End the burst cleanly; boosted velocity must not leak into ordinary movement damping.
        const current = player.wasDashing ? { x: 0, z: 0 }
            : { x: velocity.x.get(player.body), z: velocity.z.get(player.body) };
        let next = player.dashVelocity ?? movementVelocity(current, player.input, world.time.deltaTime);
        if (player.dashVelocity && player.dashTarget) {
            // Approach an absolute music-time target through the solver. Repeated
            // fixed ticks at a held audio position cannot add extra dash distance.
            const translation = world.storage(GlobalTransform).translation;
            const x = (player.dashTarget.x - translation.x.get(player.body)) / world.time.deltaTime;
            const z = (player.dashTarget.z - translation.z.get(player.body)) / world.time.deltaTime;
            const speed = Math.hypot(player.dashVelocity.x, player.dashVelocity.z);
            const scale = Math.min(1, speed / Math.max(1e-9, Math.hypot(x, z)));
            next = { x: x * scale, z: z * scale };
        }
        player.wasDashing = !!player.dashVelocity;
        setLinearVelocity(world, player.body, { x: next.x, y: 0, z: next.z });
    },
};

export const SnapshotPlayer: System = {
    name: "Beatshooter/SnapshotPlayer", group: "fixed", after: [StepPhysicsSystem],
    update(world) {
        const player = world.resource(PlayerState);
        const translation = world.storage(GlobalTransform).translation;
        player.previous = player.position;
        player.position = { x: translation.x.get(player.body), z: translation.z.get(player.body) };
    },
};

export const PresentPlayer: System = {
    name: "Beatshooter/PresentPlayer", group: "simulation",
    update(world) {
        const player = world.resource(PlayerState), arena = world.resource(Arena);
        const alpha = world.time.paused ? 1 : world.time.fixedAlpha;
        const x = player.previous.x + (player.position.x - player.previous.x) * alpha;
        const z = player.previous.z + (player.position.z - player.previous.z) * alpha;
        const pose = world.storage(Transform);
        pose.translation.set(arena.camera, x * 0.28, 32, 19 + z * 0.28);
        // Cosmetic entities never write the solver's body pose.
        const rotation = lookAtRotation(0, 0, 0, player.aim.x, 0, player.aim.z);
        for (const eid of player.visual?.parts ?? []) {
            pose.translation.set(eid, x, 0.55, z);
            pose.rotation.set(eid, ...rotation);
        }
        for (const eid of arena.reticle) pose.translation.set(eid, player.target.x, 0.55, player.target.z);
    },
};

export const PlayerPlugin: Plugin = {
    name: "Beatshooter/Player", deterministic: false, recovery: "stateless",
    dependencies: [StandardPhysicsPlugin], components: [Player],
    initialize(world) {
        world.resource(PhysicsWorldDefinition).gravity = { x: 0, y: 0, z: 0 };
        const player = world.resource(PlayerState);
        player.body = world.create();
        world.add(player.body, Player);
        world.add(player.body, Transform, { translation: [0, 0.55, 0] });
        world.add(player.body, Body, { type: BodyType.Dynamic, motionLocks: PLANAR_LOCKS, gravityScale: 0, enableSleep: 0 });
        world.add(player.body, Shape, { kind: ShapeKind.Sphere, radius: 0.55, friction: 0, filterCategoryLow: 1, filterMaskLow: 6, filterCategoryHigh: 0, filterMaskHigh: 0 });
        player.visual = createPlayerShip(world);
        player.ship = player.visual.hull;
        player.nose = player.visual.cockpit;
        player.wings = player.visual.wings;
        if (typeof window === "undefined") return;
        const options = { signal: world.signal };
        window.addEventListener("keydown", event => {
            if ((event.target as HTMLElement)?.matches("input,select,textarea")) return;
            if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
                if (player.enabled) event.preventDefault();
                player.keys.add(event.code);
            }
        }, options);
        window.addEventListener("keyup", event => player.keys.delete(event.code), options);
        window.addEventListener("blur", () => player.keys.clear(), options);
        window.addEventListener("pointermove", event => {
            player.pointer = { x: event.clientX, y: event.clientY, active: true };
        }, options);
    },
    systems: [SamplePlayer, MovePlayer, SnapshotPlayer, PresentPlayer],
};
