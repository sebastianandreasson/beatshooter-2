import { describe, expect, test } from "bun:test";
import { createApp } from "@dylanebert/shallot";
import { PlayerState } from "../player";
import { Session } from "../session";
import type { MusicTransport, TransportState } from "../rhythm/transport";
import { SampleDash, tryDash } from "./index";
import { DashState } from "./state";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app;
    const session = world.resource(Session);
    const player = world.resource(PlayerState);
    const clock = {
        position: 2,
        state: "playing" as TransportState,
        context: { state: "running" as AudioContextState },
    };
    session.transport = clock as unknown as MusicTransport;
    session.phase = "playing";
    session.position = session.visualPosition = 2;
    player.enabled = true;
    return { app, world, session, player, clock, dash: world.resource(DashState) };
}

describe("dash input and accepted music-clock integration", () => {
    test("phase, count-in, end, disabled player, suspended audio and stale observation reject input", async () => {
        const { app, world, session, player, clock, dash } = await fixture();
        try {
            for (const phase of ["menu", "loading", "paused", "results"] as const) {
                session.phase = phase;
                expect(tryDash(world)).toBe(false);
            }
            session.phase = "playing";
            player.enabled = false;
            expect(tryDash(world)).toBe(false);
            player.enabled = true;
            session.completePending = true;
            expect(tryDash(world)).toBe(false);
            session.completePending = false;
            session.combat.health = 0;
            expect(tryDash(world)).toBe(false);
            session.combat.health = 100;
            for (const state of ["stopped", "paused", "completed"] as const) {
                clock.state = state;
                expect(tryDash(world)).toBe(false);
            }
            clock.state = "playing";
            for (const state of ["suspended", "closed"] as const) {
                clock.context.state = state;
                expect(tryDash(world)).toBe(false);
            }
            clock.context.state = "running";
            for (const position of [-0.01, session.track.duration, Infinity, NaN]) {
                clock.position = session.position = position;
                expect(tryDash(world)).toBe(false);
            }
            clock.position = 2;
            session.position = 1.49;
            expect(tryDash(world)).toBe(false);
            expect(dash.controller.accepted).toBe(0);
            session.position = 2;
            expect(tryDash(world)).toBe(true);
            expect(dash.controller.accepted).toBe(1);
        } finally { app.dispose(); }
    });

    test("keydown uses the current raw clock and held direction, unaffected by visual calibration", async () => {
        const { app, world, session, player, clock, dash } = await fixture();
        try {
            // A calibrated visual downbeat cannot make an off-time raw press valid.
            session.preferences.settings.timingOffsetMs = 250;
            session.position = clock.position = 1.75;
            session.visualPosition = 2;
            expect(tryDash(world)).toBe(false);

            // The last frame was outside the window; the key event itself is inside.
            session.position = 1.85;
            clock.position = 1.91;
            session.preferences.settings.timingOffsetMs = -250;
            session.visualPosition = 1.6;
            player.keys.add("KeyD");
            player.input = { x: -1, z: 0 }; // Deliberately stale sampled movement.
            player.aim = { x: 0, z: -1 };
            expect(tryDash(world)).toBe(true);
            expect(dash.controller.active?.startedAt).toBe(1.91);
            expect(dash.controller.active?.direction).toEqual({ x: 1, z: 0 });
            expect(dash.controller.lastUsedBeat).toBe(4);
            expect(session.visualPosition).toBe(1.6);

            // The first burst has ended but the same downbeat's late window is still open.
            clock.position = session.position = 2.06;
            SampleDash.update!(world);
            expect(dash.controller.active).toBeUndefined();
            expect(tryDash(world)).toBe(false);
            expect(dash.controller.accepted).toBe(1);
            clock.position = session.position = 4;
            expect(tryDash(world)).toBe(true);
            expect(dash.controller.lastUsedBeat).toBe(8);
            expect(dash.controller.accepted).toBe(2);
        } finally { app.dispose(); }
    });

    test("generation, track replacement and backward seek reset consumed downbeats", async () => {
        const { app, world, session, clock, dash } = await fixture();
        try {
            expect(tryDash(world)).toBe(true);
            const firstController = dash.controller;
            session.generation++;
            SampleDash.update!(world);
            expect(dash.controller).not.toBe(firstController);
            expect(dash.controller.accepted).toBe(0);
            expect(dash.controller.lastUsedBeat).toBe(-1);
            expect(tryDash(world)).toBe(true);
            const retryController = dash.controller;
            session.track = { ...session.track, id: "dash-timing-replacement" };
            SampleDash.update!(world);
            expect(dash.controller).not.toBe(retryController);
            expect(tryDash(world)).toBe(true);

            clock.position = session.position = 4;
            expect(tryDash(world)).toBe(true);
            const beforeSeek = dash.controller;
            clock.position = session.position = 2;
            SampleDash.update!(world);
            expect(dash.controller).not.toBe(beforeSeek);
            expect(dash.controller.lastUsedBeat).toBe(-1);
            expect(tryDash(world)).toBe(true);
        } finally { app.dispose(); }
    });

    test("pause preserves a just-accepted start until accepted song time catches up", async () => {
        const { app, world, session, player, clock, dash } = await fixture();
        try {
            session.position = session.visualPosition = 1.9;
            clock.position = 1.91;
            player.keys.add("KeyW");
            expect(tryDash(world)).toBe(true);
            const active = { ...dash.controller.active!, direction: { ...dash.controller.active!.direction } };
            session.phase = "paused";
            SampleDash.update!(world);
            expect(dash.controller.active).toEqual(active);
            expect(player.dashVelocity).toBeUndefined();

            session.phase = "playing";
            SampleDash.update!(world);
            expect(dash.controller.active).toEqual(active);
            expect(player.dashVelocity).toBeUndefined();
            session.position = 1.92;
            SampleDash.update!(world);
            expect(player.dashVelocity).toEqual({ x: 0, z: -active.speed });
            session.phase = "paused";
            for (let frame = 0; frame < 10; frame++) SampleDash.update!(world);
            expect(dash.controller.active).toEqual(active);
            expect(player.dashVelocity).toBeUndefined();
            session.phase = "playing";
            session.position = 1.93;
            SampleDash.update!(world);
            expect(player.dashVelocity).toEqual({ x: 0, z: -active.speed });
            session.position = active.endsAt + 0.001;
            SampleDash.update!(world);
            expect(dash.controller.active).toBeUndefined();
            expect(player.dashVelocity).toBeUndefined();
            expect(dash.controller.accepted).toBe(1);
        } finally { app.dispose(); }
    });
});
