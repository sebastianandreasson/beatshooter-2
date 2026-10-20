import type { Plugin, System, World } from "@dylanebert/shallot";
import { PlayerState, readMovementInput, SamplePlayer, sampleAim } from "../player";
import { ObserveMusic, Session } from "../session";
import { STALL_THRESHOLD_SECONDS } from "../rhythm/transport";
import { createDashTiming } from "./timing";
import { DASH_DISTANCE, DashController, DashState } from "./state";

function synchronize(world: World) {
    const session = world.resource(Session), dash = world.resource(DashState);
    if (dash.generation !== session.generation || dash.track !== session.track ||
        session.position < dash.lastPosition - 0.001) {
        dash.controller = new DashController(createDashTiming(session.track.beats));
        dash.generation = session.generation;
        dash.track = session.track;
    }
    dash.lastPosition = session.position;
    return dash;
}

/** Sample the audio clock at the key event, avoiding a previous-frame timing penalty. */
export function tryDash(world: World): boolean {
    const session = world.resource(Session), player = world.resource(PlayerState);
    const transport = session.transport;
    if (session.phase !== "playing" || !player.enabled || session.completePending ||
        session.combat.health <= 0 || transport?.state !== "playing" ||
        transport.context.state !== "running") return false;
    const position = transport.position;
    // ObserveMusic owns stall/suspension recovery. Do not sneak input through a stale frame.
    if (position < 0 || position >= session.track.duration ||
        position - session.position > STALL_THRESHOLD_SECONDS) return false;
    sampleAim(world);
    return synchronize(world).controller.press(position, readMovementInput(player.keys), player.aim, player.position);
}

export const SampleDash: System = {
    name: "Beatshooter/SampleDash", group: "setup", after: [ObserveMusic, SamplePlayer],
    update(world) {
        const session = world.resource(Session), player = world.resource(PlayerState);
        const dash = synchronize(world);
        if (session.phase !== "playing" && session.phase !== "paused") dash.controller.active = undefined;
        dash.controller.update(session.position);
        const active = session.phase === "playing" && session.position >= (dash.controller.active?.startedAt ?? Infinity)
            ? dash.controller.active : undefined;
        player.dashVelocity = active ? {
            x: active.direction.x * active.speed, z: active.direction.z * active.speed,
        } : undefined;
        const progress = active ? Math.max(0, Math.min(1,
            (session.position - active.startedAt) / (active.endsAt - active.startedAt))) : 0;
        player.dashTarget = active ? {
            x: active.origin.x + active.direction.x * DASH_DISTANCE * progress,
            z: active.origin.z + active.direction.z * DASH_DISTANCE * progress,
        } : undefined;
    },
};

export const DashPlugin: Plugin = {
    name: "Beatshooter/Dash", deterministic: false, recovery: "stateless",
    initialize(world) {
        if (typeof window === "undefined") return;
        const dash = world.resource(DashState);
        window.addEventListener("keydown", event => {
            if (event.code !== "Space" ||
                (event.target as HTMLElement)?.closest("input,select,textarea,button,[contenteditable='true']") ||
                world.resource(Session).phase !== "playing") return;
            event.preventDefault();
            if (event.repeat || dash.held) return;
            dash.held = true;
            tryDash(world);
        }, { signal: world.signal });
        window.addEventListener("keyup", event => {
            if (event.code === "Space") dash.held = false;
        }, { signal: world.signal });
        window.addEventListener("blur", () => { dash.held = false; }, { signal: world.signal });
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) dash.held = false;
        }, { signal: world.signal });
    },
    systems: [SampleDash],
};
