/** Authored music time, in seconds. Indexes start at zero. */
export interface Beat {
    readonly time: number;
    readonly index: number;
    readonly bar: number;
    readonly beatInBar: number;
    readonly downbeat: boolean;
}

export interface Tempo {
    bpm: number;
    firstBeatOffset?: number;
    beatsPerBar?: number;
}

/** Steady-tempo fallback only. Variable-tempo tracks supply explicit timestamps. */
export function generateTimeline(
    duration: number,
    bpm: number,
    firstBeatOffset = 0,
    beatsPerBar = 4,
): Beat[] {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 21_600) {
        throw new Error("Track duration must be between 0 and 21,600 seconds.");
    }
    validateTempo(bpm, firstBeatOffset, beatsPerBar);
    if (firstBeatOffset >= duration) {
        throw new Error("The first beat must occur before the audio ends.");
    }
    const count = Math.ceil((duration - firstBeatOffset) * bpm / 60 - 1e-9);
    return Array.from({ length: count }, (_, index) => ({
        time: firstBeatOffset + index * 60 / bpm,
        index,
        bar: Math.floor(index / beatsPerBar),
        beatInBar: index % beatsPerBar,
        downbeat: index % beatsPerBar === 0,
    }));
}

export function validateTempo(bpm: number, firstBeatOffset = 0, beatsPerBar = 4): void {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
        throw new Error("Choose a tempo between 20 and 300 BPM.");
    }
    if (!Number.isFinite(firstBeatOffset) || firstBeatOffset < 0) {
        throw new Error("First-beat offset must be zero or a positive number of seconds.");
    }
    if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) {
        throw new Error("Beats per bar must be a whole number between 1 and 16.");
    }
}

/** Validates authorship metadata, including explicit variable-tempo timelines. */
export function validateTimeline(beats: readonly Beat[], duration: number): void {
    if (!Array.isArray(beats) || beats.length === 0 || beats.length > 108_000) {
        throw new Error("A track needs between 1 and 108,000 ordered beat timestamps.");
    }
    let previousTime = -Infinity;
    let previousBar = -1;
    let previousBeatInBar = -1;
    beats.forEach((beat, index) => {
        if (!beat || !Number.isFinite(beat.time) || beat.time < 0 || beat.time >= duration ||
            beat.time <= previousTime) {
            throw new Error(`Beat ${index + 1} must have an increasing timestamp within the track.`);
        }
        if (beat.index !== index || !Number.isInteger(beat.bar) || beat.bar < 0 ||
            !Number.isInteger(beat.beatInBar) || beat.beatInBar < 0 || beat.beatInBar > 15 ||
            beat.downbeat !== (beat.beatInBar === 0)) {
            throw new Error(`Beat ${index + 1} has invalid index or bar information.`);
        }
        if (index === 0 && (beat.bar !== 0 || beat.beatInBar !== 0)) {
            throw new Error("The first authored beat must begin bar zero.");
        }
        if (index > 0 && !(
            (beat.bar === previousBar && beat.beatInBar === previousBeatInBar + 1) ||
            (beat.bar === previousBar + 1 && beat.beatInBar === 0)
        )) {
            throw new Error(`Beat ${index + 1} has discontinuous bar information.`);
        }
        previousTime = beat.time;
        previousBar = beat.bar;
        previousBeatInBar = beat.beatInBar;
    });
}

/** Binary-searches authored timing for a display pulse, including variable tempo. */
export function beatAtPosition(timeline: readonly Beat[], position: number): Beat | undefined {
    if (!Number.isFinite(position) || timeline.length === 0 || position < timeline[0]!.time) {
        return undefined;
    }
    let low = 0;
    let high = timeline.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (timeline[mid]!.time <= position) low = mid + 1;
        else high = mid;
    }
    return timeline[low - 1];
}

export const visualBeatAt = beatAtPosition;

/** Advances monotonically, delivering every crossed beat once in authored order. */
export class BeatCursor {
    private next = 0;
    private previous = -Infinity;
    readonly timeline: readonly Beat[];

    constructor(timeline: readonly Beat[]) {
        this.timeline = timeline;
    }

    reset(position = 0, includeAtPosition = true): void {
        this.previous = position;
        let low = 0;
        let high = this.timeline.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            const before = includeAtPosition
                ? this.timeline[mid]!.time < position
                : this.timeline[mid]!.time <= position;
            if (before) low = mid + 1;
            else high = mid;
        }
        this.next = low;
    }

    cross(position: number): Beat[] {
        if (!Number.isFinite(position)) return [];
        // A backward jump is a seek, never an invitation to replay old commands.
        if (position < this.previous) {
            this.reset(position, false);
            return [];
        }
        this.previous = position;
        const crossed: Beat[] = [];
        while (this.next < this.timeline.length && this.timeline[this.next]!.time <= position) {
            crossed.push(this.timeline[this.next++]!);
        }
        return crossed;
    }
}
