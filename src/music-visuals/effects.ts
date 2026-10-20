import type { MusicalAge, MusicalTimeline } from "../rhythm/visual";
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
            if (event.kind === "kill" || event.kind === "level-up") {
                const target = this.timeline.nextSubdivision(event.songTime, event.visualTime);
                if (target === undefined) {
                    this.suppressed++;
                    this.addBurst({ ...event, birth: event.visualTime, quiet: true });
                } else {
                    const burst = { ...event, birth: target, quiet: false };
                    if (this.pending.length >= MAX_PENDING_BURSTS) {
                        const replace = this.pending.findIndex(item =>
                            eventPriority(item.kind) < eventPriority(burst.kind));
                        if (replace >= 0) this.pending.splice(replace, 1);
                        this.suppressed++;
                    }
                    if (this.pending.length < MAX_PENDING_BURSTS) this.pending.push(burst);
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
        // Merge crowded same-subdivision kill decoration without losing damage text.
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
    return feedbackProgress(timeline, item, age);
}

function feedbackProgress(timeline: MusicalTimeline, item: MusicalFeedback, age: MusicalAge): number {
    // Valid slow beats keep their full musical duration. The timeline's gap
    // envelope retires feedback without inventing beats or reviving it later.
    // A chart with no preceding beat still needs bounded essential feedback.
    const born = timeline.sample(item.birth);
    const hold = born.beatPhase < 1e-9 ? 0 : 1 - born.beatPhase;
    return Math.max(age.beats / (hold + 1), 1 - age.strength, born.beatIndex < 0 ? age.seconds / 1.5 : 0);
}

/**
 * Hits confirm immediately at rest. The next actual beat starts the pop/rise,
 * and the following beat ends it, so offbeat impacts share the music's accents.
 * Progress describes that one-beat exit; it stays zero during the initial hold.
 */
export function damageNumberPose(
    timeline: MusicalTimeline, item: MusicalFeedback, position: number, motion: boolean,
) {
    const age = timeline.ageSince(item.birth, position);
    const born = timeline.sample(item.birth);
    const hold = born.beatPhase < 1e-9 ? 0 : 1 - born.beatPhase;
    const progress = Math.max(0, Math.min(1,
        born.beatIndex < 0 ? age.seconds / 1.5 : age.beats - hold));
    const moving = motion && born.active && age.beats + 1e-9 >= hold;
    const settle = Math.min(1, progress * 4);
    const fade = Math.max(0, (progress - 0.45) / 0.55);
    return {
        progress,
        rise: moving ? (1 - (1 - progress) ** 2) * 1.15 : 0,
        scale: moving ? 1 + (item.critical ? 0.2 : 0.12) * (1 - settle) ** 2 : 1,
        opacity: (1 - fade * fade * (3 - 2 * fade)) * age.strength,
    };
}

export function burstAge(timeline: MusicalTimeline, burst: Burst, position: number): number {
    if (position < burst.birth) return -1;
    const age = timeline.ageSince(burst.birth, position);
    const beats = burst.kind === "level-up" && !burst.quiet ? 2
        : burst.kind === "spawn" ? 1.5 : burst.kind === "shot" ? 0.3 : burst.quiet ? 0.7 : 1.1;
    // The real song clock bounds fades across missing detections without a separate timer.
    return Math.max(age.beats / beats,
        age.seconds / (burst.kind === "shot" ? 0.3 : burst.kind === "level-up" ? 2 : 1.25));
}

function noise(id: number, lane: number): number {
    let n = Math.imul(id + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(lane + 1, 0xc2b2ae35);
    n = Math.imul(n ^ n >>> 16, 0x7feb352d);
    return ((n ^ n >>> 15) >>> 0) / 4294967296;
}

export function shardPose(burst: Burst, index: number, age: number, motion: boolean) {
    const seed = burst.id ^ Math.imul(burst.generation, 65537);
    if (burst.kind === "level-up") {
        // Two staggered coronas. Their rise and spread are analytic musical
        // envelopes, so pause and dropped frames cannot change the trajectory.
        const angle = index * Math.PI * (3 - Math.sqrt(5)) + noise(seed, 0) * Math.PI * 2;
        const moving = motion && !burst.quiet;
        const spread = moving ? (1 - (1 - age) ** 3) * 1.55 : 0;
        const distance = (moving ? 0.45 : 0.2) + spread * (0.7 + noise(seed, index + 17) * 0.3);
        return {
            x: burst.x + Math.cos(angle) * distance,
            z: burst.z + Math.sin(angle) * distance,
            y: 0.48 + (moving ? Math.sin(age * Math.PI * 0.8) * (0.65 + noise(seed, index + 29) * 0.55) : 0),
            scale: Math.max(0, 1 - age) * (0.11 + noise(seed, index + 31) * 0.06),
            rotation: angle + (moving ? age * Math.PI * 0.5 : 0),
        };
    }
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
