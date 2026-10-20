import { beatTravel, beatVelocity } from "../rhythm/pulse";

export interface EnemyMovementBeat { time: number; duration: number }

/** Gaps/terminal beats release one bounded stride, never an invented beat train. */
export function movementBeat(time: number, nextTime?: number | null, previous?: EnemyMovementBeat): EnemyMovementBeat {
    const interval = typeof nextTime === "number" ? nextTime - time : NaN;
    return {
        time,
        duration: Number.isFinite(interval) && interval >= 0.12 && interval <= 3.05
            ? interval : previous?.duration ?? 0.5,
    };
}

/**
 * Average velocity over the physics step ending at the actual music position.
 * The integral preserves travel at different tick rates; long beats cap the
 * stride length instead of making an enemy jump across the arena.
 */
export function enemyStrideGain(
    beat: EnemyMovementBeat | undefined, position: number, dt = 0, previousPosition = position - dt,
): number {
    if (!beat || !Number.isFinite(position) || !Number.isFinite(beat.time) || position < beat.time) return 0;
    const span = Math.min(0.9, beat.duration);
    if (!(span > 0)) return 0;
    const phase = (position - beat.time) / span;
    if (!(dt > 0) || !Number.isFinite(dt)) return beatVelocity(phase);
    const previous = Number.isFinite(previousPosition) && previousPosition <= position ? previousPosition : position - dt;
    return span * (beatTravel(phase) - beatTravel((previous - beat.time) / span)) / dt;
}
