import { expect, test } from "bun:test";
import { aimDirection, movementVelocity, planeIntersection } from "./movement";

test("diagonal input has the same top speed and damping is frame-rate independent", () => {
    const simulate = (hz: number, x: number, z: number) => {
        let velocity = { x: 0, z: 0 };
        for (let i = 0; i < hz; i++) velocity = movementVelocity(velocity, { x, z }, 1 / hz);
        return Math.hypot(velocity.x, velocity.z);
    };
    expect(simulate(60, 1, 1)).toBeCloseTo(simulate(60, 1, 0), 9);
    expect(simulate(144, 1, 0)).toBeCloseTo(simulate(30, 1, 0), 9);
    expect(movementVelocity({ x: 8, z: 0 }, { x: 0, z: 0 }, 1).x).toBeLessThan(0.001);
});

test("aim intersects the play plane and retains last direction for invalid targets", () => {
    expect(planeIntersection([2, 10, 3], [0, -1, 0])).toEqual({ x: 2, z: 3 });
    expect(planeIntersection([0, 10, 0], [1, 0, 0])).toBeNull();
    expect(planeIntersection([0, 10, 0], [0, 1, 0])).toBeNull();
    expect(aimDirection({ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 })).toEqual({ x: 1, z: 0 });
});
