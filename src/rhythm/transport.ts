import { BeatCursor, type Beat, validateTempo, validateTimeline } from "./timeline";

export type TransportState = "stopped" | "playing" | "paused" | "completed";
export type PauseReason = "user" | "hidden" | "suspended" | "stall" | "upgrade";

export interface TransportTrack {
    duration: number;
    bpm: number;
    beats: readonly Beat[];
    beatsPerBar?: number;
    buffer?: AudioBuffer;
    countInBeats?: number;
    metronome?: boolean;
}

export interface ScheduledBeat extends Beat {
    /** Actual scheduled AudioContext time, unaffected by the visual offset. */
    scheduledTime: number;
}

export interface TransportObservation {
    position: number;
    visualPosition: number;
    beats: ScheduledBeat[];
    /** True on exactly one observation per completed playthrough. */
    completed: boolean;
    pausedReason?: PauseReason;
    /** One observation only: the slowdown reached its exact musical boundary. */
    slowedToPause?: boolean;
}

export interface Volumes {
    master: number;
    music: number;
    effects: number;
}

const LEAD_IN = 0.04;
const LOOK_AHEAD = 0.18;
const SLOWDOWN_FINAL_RATE = 0.12;
export const STALL_THRESHOLD_SECONDS = 0.5;

interface Slowdown {
    startContextTime: number;
    startPosition: number;
    targetPosition: number;
    duration: number;
}

/**
 * Music clock over the public Shallot AudioOutput context/bus. This class owns
 * its nodes; it never closes Shallot's context. Call observe each rendered frame.
 * Call context.resume() directly from the start/resume button's user gesture.
 */
export class MusicTransport {
    readonly context: AudioContext;
    readonly masterGain: GainNode;
    readonly musicGain: GainNode;
    readonly effectsGain: GainNode;
    /** Transition envelope is independent of the user's music-volume setting. */
    readonly transitionGain: GainNode;
    private track: TransportTrack | null = null;
    private cursor = new BeatCursor([]);
    private source: AudioBufferSourceNode | null = null;
    private clicks = new Map<OscillatorNode, { gain: GainNode; time: number }>();
    private anchorContextTime = 0;
    private anchorPosition = 0;
    private heldPosition = 0;
    private lastObservationTime = 0;
    private lastObservedPosition = 0;
    private clickCursor = 0;
    private timelineClickCursor = 0;
    private completionDelivered = false;
    private visualOffset = 0;
    private disposed = false;
    private currentState: TransportState = "stopped";
    private reason: PauseReason | undefined;
    private slowdown: Slowdown | null = null;

    constructor(
        context: AudioContext,
        destination: AudioNode = context.destination,
    ) {
        this.context = context;
        this.masterGain = context.createGain();
        this.musicGain = context.createGain();
        this.effectsGain = context.createGain();
        this.transitionGain = context.createGain();
        this.masterGain.connect(destination);
        this.musicGain.connect(this.transitionGain);
        this.transitionGain.connect(this.masterGain);
        this.effectsGain.connect(this.masterGain);
    }

    get state(): TransportState {
        return this.currentState;
    }

    get position(): number {
        if (this.currentState !== "playing") return this.heldPosition;
        return this.positionAtContextTime(this.context.currentTime);
    }

    /** Instantaneous music speed, also used to drive the game's time scale. */
    get playbackRate(): number {
        if (this.currentState !== "playing") return 0;
        if (!this.slowdown) return 1;
        const elapsed = Math.max(0, this.context.currentTime - this.slowdown.startContextTime);
        if (this.context.currentTime >= this.slowdown.startContextTime + this.slowdown.duration) return 0;
        return 1 - (1 - SLOWDOWN_FINAL_RATE) * elapsed / this.slowdown.duration;
    }

    get slowing(): boolean {
        return this.currentState === "playing" && this.slowdown !== null;
    }

    get slowdownTarget(): number | undefined {
        return this.slowdown?.targetPosition;
    }

    /** Musical-distance progress, so card movement follows the slowing track. */
    get slowdownProgress(): number {
        if (!this.slowdown) return 0;
        return Math.max(0, Math.min(1,
            (this.position - this.slowdown.startPosition) /
            (this.slowdown.targetPosition - this.slowdown.startPosition),
        ));
    }

    /**
     * Slow to a future authored boundary, then pause there. Linear playback-rate
     * automation has a quadratic playhead; use that same integral for gameplay,
     * visuals and metronome scheduling rather than a frame-delta approximation.
     */
    beginSlowdown(stopPosition: number): boolean {
        this.assertUsable();
        const startPosition = this.position;
        if (!this.track || this.currentState !== "playing" || this.slowdown ||
            this.context.state !== "running" || startPosition < 0 ||
            this.context.currentTime < this.anchorContextTime ||
            !Number.isFinite(stopPosition) || stopPosition <= startPosition + 1e-6 ||
            stopPosition > this.track.duration) return false;
        const now = this.context.currentTime;
        const duration = 2 * (stopPosition - startPosition) / (1 + SLOWDOWN_FINAL_RATE);
        this.slowdown = {
            startContextTime: now,
            startPosition,
            targetPosition: stopPosition,
            duration,
        };
        const end = now + duration;
        if (this.source) {
            this.source.playbackRate.cancelScheduledValues(now);
            this.source.playbackRate.setValueAtTime(1, now);
            this.source.playbackRate.linearRampToValueAtTime(SLOWDOWN_FINAL_RATE, end);
            this.source.stop(end);
        }
        this.transitionGain.gain.cancelScheduledValues(now);
        this.transitionGain.gain.setValueAtTime(1, now);
        this.transitionGain.gain.setValueAtTime(1, now + duration * 0.75);
        this.transitionGain.gain.linearRampToValueAtTime(0, end);
        // Replace only future clicks. Already audible click tails can finish;
        // the cursor starts strictly after this position to avoid duplicates.
        this.cancelFutureClicks(now);
        this.timelineClickCursor = this.track.beats.findIndex(
            (beat) => beat.time > startPosition + 1e-8,
        );
        if (this.timelineClickCursor < 0) this.timelineClickCursor = this.track.beats.length;
        this.scheduleClicks();
        return true;
    }

    private positionAtContextTime(time: number): number {
        if (this.slowdown && time >= this.slowdown.startContextTime) {
            if (time >= this.slowdown.startContextTime + this.slowdown.duration) {
                return this.slowdown.targetPosition;
            }
            const elapsed = Math.min(this.slowdown.duration, time - this.slowdown.startContextTime);
            return this.slowdown.startPosition + elapsed -
                (1 - SLOWDOWN_FINAL_RATE) * elapsed * elapsed / (2 * this.slowdown.duration);
        }
        return Math.min(
            this.track?.duration ?? 0,
            this.anchorPosition + Math.max(0, time - this.anchorContextTime),
        );
    }

    /**
     * Positive milliseconds advance the visual beat display. This does not move
     * audio, rewrite beat timestamps, or alter combat command timing.
     */
    setVisualOffset(milliseconds: number): void {
        if (!Number.isFinite(milliseconds)) return;
        this.visualOffset = Math.max(-0.5, Math.min(0.5, milliseconds / 1000));
    }

    get visualPosition(): number {
        return this.position + this.visualOffset;
    }

    setVolumes(volumes: Partial<Volumes>): void {
        for (const [key, gain] of [
            ["master", this.masterGain],
            ["music", this.musicGain],
            ["effects", this.effectsGain],
        ] as const) {
            const value = volumes[key];
            if (value !== undefined && Number.isFinite(value)) {
                gain.gain.setValueAtTime(Math.max(0, Math.min(1, value)), this.context.currentTime);
            }
        }
    }

    /** Does not resume a suspended context after a delayed file load. */
    async start(track: TransportTrack): Promise<void> {
        this.assertUsable();
        validateTempo(track.bpm, 0, track.beatsPerBar ?? 4);
        if (!Number.isFinite(track.duration) || track.duration <= 0) {
            throw new Error("The audio needs a positive finite duration.");
        }
        validateTimeline(track.beats, track.duration);
        const countIn = track.countInBeats ?? 4;
        if (!Number.isInteger(countIn) || countIn < 0 || countIn > 16) {
            throw new Error("Count-in must be a whole number between 0 and 16.");
        }
        if (this.context.state !== "running") {
            throw new Error("Audio is suspended. Press Play again to enable browser audio.");
        }
        this.stopNodes();
        this.track = { ...track };
        this.cursor = new BeatCursor(track.beats);
        this.heldPosition = -countIn * 60 / track.bpm;
        this.cursor.reset(this.heldPosition, true);
        this.completionDelivered = false;
        this.schedule(this.heldPosition);
    }

    pause(reason: PauseReason = "user"): void {
        if (this.currentState !== "playing") return;
        if (reason !== "user") {
            this.pauseAtLastObservation(reason);
            return;
        }
        this.heldPosition = this.position;
        this.stopNodes();
        this.currentState = "paused";
        this.reason = reason;
    }

    /** Immediate resumes keep upgrade selection and fixed gameplay on one clock. */
    async resume(options: { immediate?: boolean } = {}): Promise<void> {
        this.assertUsable();
        if (this.currentState !== "paused" || !this.track) return;
        const pendingTrack = this.track;
        const pendingPosition = this.heldPosition;
        // UI should resume immediately in its gesture handler. Also support
        // direct calls from a gesture for consumers without that adapter.
        if (this.context.state !== "running") await this.context.resume();
        // A stop, restart, seek, disposal, or another successful resume wins
        // while browser permission is pending. Never resurrect its old source.
        if (this.disposed || this.currentState !== "paused" ||
            this.track !== pendingTrack || this.heldPosition !== pendingPosition) return;
        if (this.context.state !== "running") {
            throw new Error("Audio could not start. Allow sound, then press Resume again.");
        }
        this.schedule(this.heldPosition, options.immediate ? 0 : LEAD_IN);
    }

    seek(position: number): void {
        this.assertUsable();
        if (!this.track || !Number.isFinite(position)) return;
        const playing = this.currentState === "playing";
        this.stopNodes();
        this.heldPosition = Math.max(0, Math.min(this.track.duration, position));
        this.cursor.reset(this.heldPosition, false);
        this.completionDelivered = false;
        this.reason = undefined;
        if (playing) this.schedule(this.heldPosition);
        else this.currentState = "paused";
    }

    async restart(): Promise<void> {
        if (this.track) await this.start(this.track);
    }

    observe(): TransportObservation {
        const noEvents = (): TransportObservation => ({
            position: this.position,
            visualPosition: this.visualPosition,
            beats: [],
            completed: false,
            pausedReason: this.reason,
        });
        if (this.currentState !== "playing" || !this.track) return noEvents();
        if (this.context.state !== "running") {
            this.pauseAtLastObservation("suspended");
            return noEvents();
        }
        if (this.context.currentTime - this.lastObservationTime > STALL_THRESHOLD_SECONDS) {
            // Freeze at the accepted simulation time; discard missed commands
            // and unheard progress rather than releasing a backlog of shots.
            this.pauseAtLastObservation("stall");
            return noEvents();
        }
        const position = this.position;
        this.lastObservationTime = this.context.currentTime;
        this.lastObservedPosition = position;
        this.scheduleClicks();
        const crossed = this.context.currentTime < this.anchorContextTime
            ? [] : this.cursor.cross(position);
        const beats = crossed.map((beat) => ({
            ...beat,
            scheduledTime: this.contextTimeAtPosition(beat.time),
        }));
        let completed = false;
        let slowedToPause = false;
        if (position >= this.track.duration && !this.completionDelivered) {
            this.completionDelivered = true;
            completed = true;
            this.heldPosition = this.track.duration;
            this.stopNodes();
            this.currentState = "completed";
        } else if (this.slowdown && position >= this.slowdown.targetPosition) {
            this.heldPosition = this.slowdown.targetPosition;
            this.stopNodes(true);
            this.currentState = "paused";
            this.reason = "upgrade";
            slowedToPause = true;
        }
        return {
            position,
            visualPosition: position + this.visualOffset,
            beats,
            completed,
            ...(slowedToPause ? { pausedReason: this.reason, slowedToPause } : {}),
        };
    }

    stop(): void {
        this.stopNodes();
        this.currentState = "stopped";
        this.heldPosition = 0;
        this.reason = undefined;
        this.completionDelivered = false;
        this.cursor.reset(0, true);
    }

    /** Release decoded audio when the selected local file is replaced. */
    unload(): void {
        this.stop();
        this.track = null;
        this.cursor = new BeatCursor([]);
    }

    /** Stop preview/session sources and disconnect all owned nodes. */
    dispose(): void {
        if (this.disposed) return;
        this.stop();
        this.track = null;
        this.masterGain.disconnect();
        this.musicGain.disconnect();
        this.transitionGain.disconnect();
        this.effectsGain.disconnect();
        this.disposed = true;
    }

    private schedule(position: number, leadIn = LEAD_IN): void {
        if (!this.track) return;
        this.resetSlowdown();
        this.anchorContextTime = this.context.currentTime + leadIn;
        this.anchorPosition = position;
        this.heldPosition = position;
        this.lastObservationTime = this.context.currentTime;
        this.lastObservedPosition = position;
        this.currentState = "playing";
        this.reason = undefined;
        this.clickCursor = Math.ceil(position / (60 / this.track.bpm) - 1e-8);
        this.timelineClickCursor = this.track.beats.findIndex((beat) => beat.time >= position);
        if (this.timelineClickCursor < 0) this.timelineClickCursor = this.track.beats.length;
        if (this.track.buffer && position < this.track.duration) {
            this.source = this.context.createBufferSource();
            this.source.buffer = this.track.buffer;
            this.source.connect(this.musicGain);
            this.source.start(
                this.anchorContextTime + Math.max(0, -position),
                Math.max(0, position),
            );
        }
        this.scheduleClicks();
    }

    private pauseAtLastObservation(reason: PauseReason): void {
        this.heldPosition = this.lastObservedPosition;
        this.stopNodes();
        this.currentState = "paused";
        this.reason = reason;
    }

    private scheduleClicks(): void {
        if (!this.track) return;
        const interval = 60 / this.track.bpm;
        const horizon = this.positionAtContextTime(this.context.currentTime + LOOK_AHEAD);
        while (this.clickCursor < 0 && this.clickCursor * interval <= horizon) {
            const clickTime = this.clickCursor * interval;
            const scheduled = this.contextTimeAtPosition(clickTime);
            // Never turn delayed metronome clicks into an audible burst.
            if (scheduled >= this.context.currentTime - 0.01) {
                this.click(scheduled, this.clickCursor % (this.track.beatsPerBar ?? 4) === 0);
            }
            this.clickCursor++;
        }
        if (!this.track.metronome) return;
        while (this.timelineClickCursor < this.track.beats.length &&
            this.track.beats[this.timelineClickCursor]!.time <= horizon) {
            const beat = this.track.beats[this.timelineClickCursor++]!;
            const scheduled = this.contextTimeAtPosition(beat.time);
            if (scheduled >= this.context.currentTime - 0.01) this.click(scheduled, beat.downbeat);
        }
    }

    private contextTimeAtPosition(position: number): number {
        if (!this.slowdown || position <= this.slowdown.startPosition) {
            return this.anchorContextTime + position - this.anchorPosition;
        }
        const delta = Math.min(
            position - this.slowdown.startPosition,
            this.slowdown.targetPosition - this.slowdown.startPosition,
        );
        const deceleration = (1 - SLOWDOWN_FINAL_RATE) / this.slowdown.duration;
        // Stable quadratic inverse: avoids cancellation for a nearby beat.
        const elapsed = 2 * delta / (1 + Math.sqrt(Math.max(0, 1 - 2 * deceleration * delta)));
        return this.slowdown.startContextTime + elapsed;
    }

    private click(time: number, downbeat: boolean): void {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(downbeat ? 1320 : 880, time);
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.exponentialRampToValueAtTime(downbeat ? 0.2 : 0.12, time + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
        oscillator.connect(gain);
        gain.connect(this.effectsGain);
        this.clicks.set(oscillator, { gain, time });
        oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
            this.clicks.delete(oscillator);
        };
        oscillator.start(time);
        oscillator.stop(time + 0.06);
    }

    private cancelFutureClicks(now: number): void {
        for (const [oscillator, { gain, time }] of this.clicks) {
            if (time <= now + 1e-8) continue;
            try { oscillator.stop(); } catch { /* Already ended. */ }
            oscillator.disconnect();
            gain.disconnect();
            this.clicks.delete(oscillator);
        }
    }

    private resetSlowdown(): void {
        this.slowdown = null;
        this.transitionGain.gain.cancelScheduledValues(this.context.currentTime);
        this.transitionGain.gain.setValueAtTime(1, this.context.currentTime);
    }

    private stopNodes(preserveSlowdown = false): void {
        if (this.source) {
            try { this.source.stop(); } catch { /* Already ended. */ }
            this.source.disconnect();
            this.source = null;
        }
        for (const [oscillator, { gain }] of this.clicks) {
            try { oscillator.stop(); } catch { /* Already ended. */ }
            oscillator.disconnect();
            gain.disconnect();
        }
        this.clicks.clear();
        if (!preserveSlowdown) this.resetSlowdown();
    }

    private assertUsable(): void {
        if (this.disposed) throw new Error("This audio session has already been disposed.");
    }
}
