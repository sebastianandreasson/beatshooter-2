import {
    Body, BodyMotionLock, BodyType, component, GlobalTransform, lookAtRotation,
    setLinearVelocity, setTransform, StandardPhysicsPlugin, StepPhysicsSystem,
    Transform, type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import { Shape, ShapeKind } from "@dylanebert/shallot/physics";
import { PhysicsWorldDefinition } from "@dylanebert/shallot/standard/physics";
import { viewportToWorld } from "@dylanebert/shallot/rendering";
import { Arena, box } from "../arena";
import { aimDirection, movementVelocity, planeIntersection, type Planar } from "./movement";

export const Player = component("Beatshooter/Player", {});
export const PLANAR_LOCKS = BodyMotionLock.linearY | BodyMotionLock.angularX | BodyMotionLock.angularY | BodyMotionLock.angularZ;
export const PlayerState: Resource<{
    body: number; ship: number; nose: number; wings: number[]; enabled: boolean;
    input: Planar; aim: Planar; target: Planar; previous: Planar; position: Planar;
    pointer: { x: number; y: number; active: boolean }; keys: Set<string>;
}> = { create: () => ({
    body: -1, ship: -1, nose: -1, wings: [], enabled: false,
    input: { x: 0, z: 0 }, aim: { x: 0, z: -1 }, target: { x: 0, z: -4 },
    previous: { x: 0, z: 0 }, position: { x: 0, z: 0 },
    pointer: { x: 0, y: 0, active: false }, keys: new Set(),
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
        const pressed = (a: string, b: string) => Number(player.keys.has(a) || player.keys.has(b));
        player.input = player.enabled
            ? { x: pressed("KeyD", "ArrowRight") - pressed("KeyA", "ArrowLeft"), z: pressed("KeyS", "ArrowDown") - pressed("KeyW", "ArrowUp") }
            : { x: 0, z: 0 };
        sampleAim(world);
    },
};

export const MovePlayer: System = {
    name: "Beatshooter/MovePlayer", group: "fixed", before: [StepPhysicsSystem],
    update(world) {
        const player = world.resource(PlayerState);
        if (!player.enabled) return;
        const velocity = world.storage(GlobalTransform).linearVelocity;
        const next = movementVelocity({ x: velocity.x.get(player.body), z: velocity.z.get(player.body) }, player.input, world.time.deltaTime);
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
        pose.translation.set(player.ship, x, 0.55, z);
        const rotation = lookAtRotation(0, 0, 0, player.aim.x, 0, player.aim.z);
        pose.rotation.set(player.ship, ...rotation);
        pose.translation.set(player.nose, x + player.aim.x * 0.6, 0.7, z + player.aim.z * 0.6);
        player.wings.forEach((eid, index) => {
            const side = index === 0 ? -1 : 1;
            pose.translation.set(eid,
                x - player.aim.x * 0.25 - player.aim.z * side * 0.43,
                0.45,
                z - player.aim.z * 0.25 + player.aim.x * side * 0.43,
            );
            pose.rotation.set(eid, ...rotation);
        });
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
        const materials = world.resource(Arena).materials;
        player.ship = box(world, materials.player, [0, 0.55, 0], [0.75, 0.5, 1.15]);
        player.nose = box(world, materials.white, [0, 0.7, -0.6], [0.23, 0.25, 0.23]);
        player.wings = [-1, 1].map(side => box(world, materials.player, [side * 0.43, 0.45, 0.25], [0.25, 0.25, 0.75]));
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
