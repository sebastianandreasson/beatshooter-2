import type { Resource } from "@dylanebert/shallot";
import type { Planar } from "../player/movement";
import type { TrackManifest } from "../tracks";
import { createDashTiming, type DashTiming } from "./timing";

export type DashStatus = "ready" | "used" | "waiting" | "dashing";
export const DASH_DISTANCE = 3.6;

export interface ActiveDash {
    beatIndex: number;
    startedAt: number;
    endsAt: number;
    direction: Planar;
    origin: Planar;
    speed: number;
}

/** Input is judged immediately. A missed press is never buffered for a later beat. */
export class DashController {
    readonly timing: DashTiming;
    active?: ActiveDash;
    lastUsedBeat = -1;
    accepted = 0;

    constructor(timing: DashTiming) { this.timing = timing; }

    /** Session cleanup is synchronous; rebuilding the chart can wait for setup. */
    reset(): void {
        this.active = undefined;
        this.lastUsedBeat = -1;
        this.accepted = 0;
    }

    press(position: number, movement: Planar, aim: Planar, origin: Planar = { x: 0, z: 0 }): boolean {
        this.update(position);
        const beat = this.timing.candidate(position);
        if (this.active || !beat || beat.beatIndex <= this.lastUsedBeat) return false;
        const input = Math.hypot(movement.x, movement.z) > 0 ? movement : aim;
        const length = Math.hypot(input.x, input.z);
        const direction = Number.isFinite(length) && length > 0
            ? { x: input.x / length, z: input.z / length } : { x: 0, z: -1 };
        const duration = Math.max(0.08, Math.min(0.18, beat.beatDuration / 4));
        this.active = {
            beatIndex: beat.beatIndex, startedAt: position, endsAt: position + duration,
            direction, origin: { ...origin }, speed: DASH_DISTANCE / duration,
        };
        this.lastUsedBeat = beat.beatIndex;
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
        return beat ? beat.beatIndex <= this.lastUsedBeat ? "used" : "ready" : "waiting";
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
