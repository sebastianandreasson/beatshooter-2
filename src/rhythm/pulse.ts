import type { MusicalFrame } from "./visual";

/** Launch on the beat, ease out over its first 55%, then hold for the next beat. */
export const BEAT_DRIVE = 0.55;
const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Integral of the beat velocity: continuous, monotonic and exactly one per beat. */
export function beatTravel(phase: number): number {
    const p = unit(phase / BEAT_DRIVE);
    return p * (2 - p);
}

export function beatVelocity(phase: number): number {
    if (!Number.isFinite(phase) || phase < 0 || phase >= BEAT_DRIVE) return 0;
    return 2 * (1 - phase / BEAT_DRIVE) / BEAT_DRIVE;
}

export function beatEnvelope(phase: number): number {
    return 1 - beatTravel(phase);
}

/** No wall-clock velocity: every new unit of travel requires an authored beat. */
export function beatMotionCoordinate(frame: MusicalFrame, amount = 1): number {
    if (frame.beatIndex < 0) return 0;
    return frame.beatIndex + frame.beatPhase + (beatTravel(frame.beatPhase) - frame.beatPhase) * unit(amount);
}
