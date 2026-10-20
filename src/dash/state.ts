import type { Resource } from "@dylanebert/shallot";
import type { Planar } from "../player/movement";
import { DEFAULT_PLAYER_STATS, MAX_DASH_DISTANCE } from "../player-stats";
import type { TrackManifest } from "../tracks";
import { createDashTiming, type DashTiming } from "./timing";

export type DashStatus = "ready" | "used" | "waiting" | "dashing";
export const DASH_DISTANCE = DEFAULT_PLAYER_STATS.dashDistance;

export interface ActiveDash {
    beatIndex: number;
    startedAt: number;
    endsAt: number;
    direction: Planar;
    origin: Planar;
    distance: number;
    speed: number;
}

/** Input is judged immediately. A missed press is never buffered for a later beat. */
export class DashController {
    readonly timing: DashTiming;
    active?: ActiveDash;
    lastUsedBeat = -1;
    lastUsedBar = -1;
    accepted = 0;

    constructor(timing: DashTiming) { this.timing = timing; }

    /** Session cleanup is synchronous; rebuilding the chart can wait for setup. */
    reset(): void {
        this.active = undefined;
        this.lastUsedBeat = -1;
        this.lastUsedBar = -1;
        this.accepted = 0;
    }

    press(
        position: number, movement: Planar, aim: Planar,
        origin: Planar = { x: 0, z: 0 }, distance = DEFAULT_PLAYER_STATS.dashDistance,
    ): boolean {
        if (!Number.isFinite(distance) || distance <= 0) return false;
        this.update(position);
        const beat = this.timing.candidate(position);
        if (this.active || !beat || beat.beatIndex <= this.lastUsedBeat || beat.bar <= this.lastUsedBar) return false;
        const input = Math.hypot(movement.x, movement.z) > 0 ? movement : aim;
        const length = Math.hypot(input.x, input.z);
        const direction = Number.isFinite(length) && length > 0
            ? { x: input.x / length, z: input.z / length } : { x: 0, z: -1 };
        const duration = Math.max(0.08, Math.min(0.18, beat.beatDuration / 4));
        const capturedDistance = Math.min(MAX_DASH_DISTANCE, distance);
        this.active = {
            beatIndex: beat.beatIndex, startedAt: position, endsAt: position + duration,
            direction, origin: { ...origin }, distance: capturedDistance, speed: capturedDistance / duration,
        };
        this.lastUsedBeat = beat.beatIndex;
        // An early press on the next bar's first beat spends that next bar.
        // Crossing its timestamp must not grant a second use.
        this.lastUsedBar = beat.bar;
        this.accepted++;
        return true;
    }

    update(position: number): void {
        if (this.active && position >= this.active.endsAt) {
            this.active = undefined;
        }
    }

    status(position: number): DashStatus {
        if (this.active && position >= this.active.startedAt && position < this.active.endsAt) return "dashing";
        const beat = this.timing.candidate(position);
        const bar = beat?.bar ?? this.timing.barAt(position);
        if (bar !== undefined && bar <= this.lastUsedBar) return "used";
        return beat ? "ready" : "waiting";
    }
}

export const DashState: Resource<{
    generation: number; track?: TrackManifest; lastPosition: number;
    controller: DashController; held: boolean;
}> = {
    create: () => ({
        generation: -1, lastPosition: 0,
        controller: new DashController(createDashTiming([])), held: false,
    }),
};
