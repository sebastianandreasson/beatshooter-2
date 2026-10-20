import type { MusicalTimeline } from "../rhythm/visual";
import { eventPriority, type MusicEvent } from "./events";

export interface Burst extends MusicEvent {
    birth: number;
    quiet: boolean;
}
export interface MusicalFeedback extends MusicEvent { birth: number }
export const MAX_PENDING_BURSTS = 16;
export const MAX_ACTIVE_BURSTS = 32;
export const MAX_FEEDBACK = 100;

/** Bounded event ownership. All ages are functions of the supplied music time. */
export class EffectDirector {
    timeline: MusicalTimeline;
    generation: number;
    bursts: Burst[] = [];
    pending: Burst[] = [];
    feedback: MusicalFeedback[] = [];
    accepted = 0;
    suppressed = 0;
    private lastId = 0;

    constructor(timeline: MusicalTimeline, generation: number) {
        this.timeline = timeline;
        this.generation = generation;
    }

    clear(): void {
        this.bursts.length = this.pending.length = this.feedback.length = 0;
        this.lastId = 0;
    }

    consume(events: readonly MusicEvent[], decoration: boolean): void {
        for (const event of events) {
            if (event.generation !== this.generation || event.id <= this.lastId) continue;
            this.lastId = event.id;
            this.accepted++;
            if (event.kind === "hit" || event.kind === "kill" || event.kind === "player-hit") {
                if (this.feedback.length >= MAX_FEEDBACK) {
                    const replace = this.feedback.findIndex(item => eventPriority(item.kind) <= eventPriority(event.kind));
                    if (replace >= 0) this.feedback.splice(replace, 1);
                }
                if (this.feedback.length < MAX_FEEDBACK) this.feedback.push({ ...event, birth: event.visualTime });
            }
            if (!decoration) continue;
            if (event.kind === "kill") {
                const target = this.timeline.nextSubdivision(event.songTime, event.visualTime);
                if (target === undefined) {
                    this.suppressed++;
                    this.addBurst({ ...event, birth: event.visualTime, quiet: true });
                } else {
                    const burst = { ...event, birth: target, quiet: false };
                    if (this.pending.length < MAX_PENDING_BURSTS) this.pending.push(burst);
                    else this.suppressed++;
                }
            } else {
                // Shot/spawn commands already carry their authored beat time.
                this.addBurst({
                    ...event, birth: event.beatTime ?? event.visualTime,
                    quiet: event.kind === "hit" || event.kind === "player-hit",
                });
            }
        }
    }

    private addBurst(burst: Burst): void {
        // Merge crowded same-subdivision kill decoration without losing score text.
        if (burst.kind === "kill" && this.bursts.some(other =>
            other.kind === "kill" && Math.abs(other.birth - burst.birth) < 0.001 &&
            Math.hypot(other.x - burst.x, other.z - burst.z) < 1.5)) return;
        if (this.bursts.length >= MAX_ACTIVE_BURSTS) {
            const replace = this.bursts.findIndex(item => eventPriority(item.kind) < eventPriority(burst.kind));
            if (replace < 0) { this.suppressed++; return; }
            this.bursts.splice(replace, 1);
        }
        this.bursts.push(burst);
    }

    step(position: number, decoration: boolean): void {
        this.feedback = this.feedback.filter(item => feedbackAge(this.timeline, item, position) < 1);
        if (!decoration) { this.pending.length = this.bursts.length = 0; return; }
        this.bursts = this.bursts.filter(item => burstAge(this.timeline, item, position) < 1);
        const future: Burst[] = [];
        for (const burst of this.pending) {
            if (burst.birth > position) future.push(burst);
            // A skipped rendered frame evaluates the existing envelope, never restarts it.
            else if (burstAge(this.timeline, burst, position) < 1) this.addBurst(burst);
        }
        this.pending = future;
    }
}

export function feedbackAge(timeline: MusicalTimeline, item: MusicalFeedback, position: number): number {
    const age = timeline.ageSince(item.birth, position);
    return Math.max(age.beats / 1.5, age.seconds / 1.5);
}

export function burstAge(timeline: MusicalTimeline, burst: Burst, position: number): number {
    if (position < burst.birth) return -1;
    const age = timeline.ageSince(burst.birth, position);
    const beats = burst.kind === "spawn" ? 1.5 : burst.kind === "shot" ? 0.3 : burst.quiet ? 0.7 : 1.1;
    // The real song clock bounds fades across missing detections without a separate timer.
    return Math.max(age.beats / beats, age.seconds / (burst.kind === "shot" ? 0.3 : 1.25));
}

function noise(id: number, lane: number): number {
    let n = Math.imul(id + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(lane + 1, 0xc2b2ae35);
    n = Math.imul(n ^ n >>> 16, 0x7feb352d);
    return ((n ^ n >>> 15) >>> 0) / 4294967296;
}

export function shardPose(burst: Burst, index: number, age: number, motion: boolean) {
    const seed = burst.id ^ Math.imul(burst.generation, 65537);
    const angle = noise(seed, index) * Math.PI * 2;
    const travel = burst.quiet || !motion ? 0.06 : (1 - (1 - age) ** 3) * (burst.critical ? 1.6 : 1.15);
    const distance = (0.08 + travel) * (0.6 + noise(seed, index + 17));
    return {
        x: burst.x + Math.cos(angle) * distance,
        z: burst.z + Math.sin(angle) * distance,
        y: 0.48 + (motion && !burst.quiet ? Math.sin(age * Math.PI) * 0.55 : 0),
        scale: Math.max(0, 1 - age) * (burst.kind === "shot" ? 0.08 : 0.1 + noise(seed, index + 31) * 0.07),
        rotation: angle + (motion ? age * (noise(seed, index + 47) - 0.5) * 2 : 0),
    };
}
