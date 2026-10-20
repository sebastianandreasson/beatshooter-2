import { describe, expect, test } from "bun:test";
import { DashController } from "../dash/state";
import { createDashTiming } from "../dash/timing";
import { generateTimeline } from "../rhythm/timeline";
import { sampleShipEngine } from "./engine";

const controller = () => new DashController(createDashTiming(generateTimeline(12, 120)));
const frame = (dash: DashController, position: number, motionAllowed = true, available = true) =>
    sampleShipEngine({
        status: dash.status(position), position, available, motionAllowed, calm: false,
        active: dash.active,
    });

describe("ship engines follow actual dash eligibility", () => {
    test("the engine lights across the full input window and dims between beats", () => {
        const dash = controller();
        const waiting = frame(dash, 0.25);
        expect(waiting.status).toBe("waiting");
        for (const position of [0.35, 0.5, 0.65]) {
            const ready = frame(dash, position);
            expect(ready.status).toBe("ready");
            expect(ready.material).toBe("ready");
            expect(ready.plumeLength).toBeGreaterThan(waiting.plumeLength);
        }
        expect(frame(dash, 0.349).material).toBe("idle");
        expect(frame(dash, 0.651).material).toBe("idle");
    });

    test("boost uses captured song timestamps and a spent dash stays dark until the next bar", () => {
        const dash = controller();
        expect(dash.press(0.5, { x: 1, z: 0 }, { x: 0, z: -1 })).toBe(true);
        const initial = frame(dash, 0.5);
        expect(initial.status).toBe("dashing");
        expect(initial.material).toBe("boost");
        expect(frame(dash, 0.5)).toEqual(initial);
        expect(frame(dash, 0.56).plumeLength).toBeLessThan(initial.plumeLength);
        dash.update(0.7);
        expect(frame(dash, 1).status).toBe("used");
        expect(frame(dash, 1).plumeLength).toBe(0);
        expect(frame(dash, 1.85).status).toBe("ready");
        dash.reset();
        expect(frame(dash, 0.5).status).toBe("ready");
    });

    test("comfort modes retain the readiness color with no animated exhaust", () => {
        const dash = controller();
        expect(frame(dash, 0.5, false)).toMatchObject({
            status: "ready", material: "ready", plumeLength: 0, coreLength: 0,
        });
        expect(frame(dash, 0.25, false).material).toBe("idle");
        dash.press(0.5, { x: 1, z: 0 }, { x: 0, z: -1 });
        expect(frame(dash, 0.5, false).material).toBe("boost");
        dash.update(0.7);
        expect(frame(dash, 1, false).material).toBe("used");
    });

    test("menus, count-in, defeat and completion cannot advertise a ready dash", () => {
        const dash = controller();
        expect(frame(dash, 0.5, true, false)).toMatchObject({
            status: "offline", material: "used", plumeLength: 0, coreLength: 0,
        });
        expect(frame(dash, NaN)).toMatchObject({ status: "offline", plumeLength: 0 });
    });
});
