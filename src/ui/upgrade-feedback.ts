import type { Beat } from "../rhythm/timeline";
import { createMusicalTimeline, type MusicalTimeline } from "../rhythm/visual";

export interface UpgradeFeedbackFrame {
    selectedOpacity: number;
    dismissedOpacity: number;
    flash: number;
    scale: number;
    done: boolean;
}

const EPSILON = 1e-9;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};
const finished = (): UpgradeFeedbackFrame => ({
    selectedOpacity: 0, dismissedOpacity: 0, flash: 0, scale: 1, done: true,
});

/**
 * A selection's short presentation lifetime, independent of update frequency.
 * The choice itself is accepted immediately; only its visible confirmation waits
 * for an authored beat. Missing intervals get a bounded fade without an accent.
 */
export class UpgradeFeedback {
    private readonly position: number;
    private readonly music: MusicalTimeline;
    private readonly birthCoordinate: number;
    private readonly quietDuration: number;
    private readonly flashTime: number | undefined;
    private readonly endTime: number;

    constructor(beats: readonly Beat[], position: number) {
        this.position = position;
        try {
            this.music = createMusicalTimeline(beats);
        } catch {
            // Corrupt presentation metadata must not trap the selection overlay.
            this.music = createMusicalTimeline([]);
        }
        const birth = this.music.sample(position);
        this.birthCoordinate = birth.beatCoordinate;
        this.quietDuration = Math.max(0.12, Math.min(0.6, birth.beatDuration || 0.6));
        this.endTime = position + this.quietDuration;
        if (!Number.isFinite(position) || !birth.active) return;

        const atBeat = birth.beatPhase < EPSILON;
        const targetIndex = birth.beatIndex + (atBeat ? 0 : 1);
        const target = beats[targetIndex]?.time, end = beats[targetIndex + 1]?.time;
        if (target === undefined || end === undefined || !this.music.sample(target).active) return;
        this.flashTime = target;
        this.endTime = end;
    }

    sample(position: number): UpgradeFeedbackFrame {
        if (!Number.isFinite(position) || !Number.isFinite(this.position) ||
            position < this.position || position >= this.endTime) return finished();
        const elapsed = position - this.position;
        if (this.flashTime === undefined) {
            return {
                selectedOpacity: 1 - smooth(elapsed / this.quietDuration),
                dismissedOpacity: 1 - smooth(elapsed / (this.quietDuration * 0.35)),
                flash: 0, scale: 1, done: false,
            };
        }
        const age = Math.max(0, this.music.sample(position).beatCoordinate - this.birthCoordinate);
        const phase = Math.max(0, (position - this.flashTime) / (this.endTime - this.flashTime));
        const flash = position < this.flashTime ? 0 : 1 - smooth(phase / 0.35);
        return {
            selectedOpacity: 1 - smooth((phase - 0.6) / 0.4),
            dismissedOpacity: 1 - smooth(age / 0.35),
            flash, scale: 1 + 0.02 * flash, done: false,
        };
    }
}

/** A finite confirmation before the music starts, using a supplied menu clock. */
export function sampleMenuUpgradeFeedback(elapsedSeconds: number, beatDuration: number): UpgradeFeedbackFrame {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return finished();
    const duration = Number.isFinite(beatDuration) && beatDuration > 0
        ? Math.max(0.12, Math.min(3.05, beatDuration)) : 0.5;
    const age = elapsedSeconds / duration;
    if (age >= 1.25) return finished();
    const flash = age < 0.25 ? 0 : 0.65 * (1 - smooth((age - 0.25) / 0.35));
    return {
        selectedOpacity: 1 - smooth((age - 0.85) / 0.4),
        dismissedOpacity: 1 - smooth(age / 0.35),
        flash, scale: 1 + 0.02 * flash, done: false,
    };
}
