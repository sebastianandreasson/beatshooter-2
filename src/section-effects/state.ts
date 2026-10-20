import { validateSections, type SectionAnalysis, type SectionLabel, type SongSection } from "../analysis/sections";
import type { Beat } from "../rhythm/timeline";
import { MusicalTimeline } from "../rhythm/visual";

export type RGB = readonly [number, number, number];

export interface SectionPalette {
    readonly floor: RGB;
    readonly line: RGB;
    readonly accent: RGB;
    readonly clearColor: RGB;
}

/** No analysis means the original floor and camera colors, not an invented section. */
export const DEFAULT_SECTION_PALETTE: SectionPalette = {
    floor: [0.008, 0.017, 0.023],
    line: [0.027, 0.083, 0.093],
    accent: [0.055, 0.29, 0.25],
    clearColor: [9 / 255, 15 / 255, 21 / 255],
};

/** Keep the arena dark and enemy/projectile colors readable throughout a change. */
export const SECTION_PALETTES: Readonly<Record<SectionLabel, SectionPalette>> = {
    intro: {
        floor: [0.00598, 0.01481, 0.025], line: [0.02393, 0.05926, 0.1],
        accent: [0.08614, 0.21333, 0.36], clearColor: [0.03929, 0.05942, 0.075],
    },
    verse: {
        floor: [0.00899, 0.023, 0.01683], line: [0.04104, 0.105, 0.07683],
        accent: [0.14071, 0.36, 0.26341], clearColor: [0.0392, 0.06, 0.05216],
    },
    chorus: {
        floor: [0.027, 0.01622, 0.00536], line: [0.105, 0.06309, 0.02086],
        accent: [0.36, 0.21632, 0.07153], clearColor: [0.065, 0.05184, 0.03127],
    },
    bridge: {
        floor: [0.01754, 0.01178, 0.027], line: [0.06819, 0.04582, 0.105],
        accent: [0.23381, 0.15709, 0.36], clearColor: [0.05777, 0.0483, 0.07],
    },
    inst: {
        floor: [0.0066, 0.02061, 0.022], line: [0.02999, 0.09366, 0.1],
        accent: [0.10796, 0.33719, 0.36], clearColor: [0.03474, 0.05828, 0.06],
    },
    outro: {
        floor: [0.025, 0.01158, 0.01398], line: [0.105, 0.04865, 0.0587],
        accent: [0.36, 0.16681, 0.20126], clearColor: [0.07, 0.0496, 0.05399],
    },
    silence: {
        floor: [0.00549, 0.00668, 0.008], line: [0.02059, 0.02503, 0.03],
        accent: [0.06862, 0.08345, 0.1], clearColor: [0.02527, 0.02764, 0.03],
    },
};

export interface SectionTransitionFrame {
    index: number;
    label: SectionLabel | undefined;
    active: boolean;
    startTime: number;
    endTime: number;
    /** Linear musical progress, retained for integrated star travel. */
    progress: number;
    /** Eased outward travel shared by color, geometry and projected labels. */
    waveProgress: number;
    /** A look-ahead charge never changes the current section or its palette. */
    anticipating: boolean;
    anticipation: number;
    /** Continuous charge/zoom envelope: peak at the boundary, settle one beat later. */
    impact: number;
    /** Smooth zero-ended intensity for the section's outward light wave. */
    envelope: number;
    from: SectionPalette;
    to: SectionPalette;
    palette: SectionPalette;
    /** False means a bounded color fade with no invented rhythmic movement. */
    musical: boolean;
}

interface Transition {
    startTime: number;
    endTime: number;
    startCoordinate: number;
    beatSpan: number;
    musical: boolean;
    anticipationStartTime: number;
    anticipationCoordinate: number;
    anticipationSpan: number;
}

const EPSILON = 1e-9;
const TRANSITION_BEATS = 4;
/** Compress an eligible wave's musical span, including section/gap-limited spans. */
const WAVE_SPEED = 1.3;
const MIN_TRANSITION_SECONDS = 0.65;
const MAX_TRANSITION_SECONDS = 3.5;
const QUIET_FADE_SECONDS = 0.6;
const ANTICIPATION_BEATS = 1;
const MAX_ANTICIPATION_SECONDS = 0.6;
const MIN_ANTICIPATION_SECONDS = 0.12;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => value * value * (3 - 2 * value);
const mixRGB = (from: RGB, to: RGB, amount: number): RGB => [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
];

function mixPalette(from: SectionPalette, to: SectionPalette, amount: number): SectionPalette {
    if (amount <= 0) return from;
    if (amount >= 1) return to;
    return {
        floor: mixRGB(from.floor, to.floor, amount),
        line: mixRGB(from.line, to.line, amount),
        accent: mixRGB(from.accent, to.accent, amount),
        clearColor: mixRGB(from.clearColor, to.clearColor, amount),
    };
}

/** Compare hue independently of brightness so two similar blue/green themes also separate. */
function paletteSeparation(a: SectionPalette, b: SectionPalette): number {
    const aPeak = Math.max(...a.accent), bPeak = Math.max(...b.accent);
    return Math.hypot(...a.accent.map((channel, index) => channel / aPeak - b.accent[index]! / bPeak));
}

function chooseSectionPalettes(sections: readonly SongSection[]): SectionPalette[] {
    const choices = Object.values(SECTION_PALETTES);
    const palettes: SectionPalette[] = [];
    for (const section of sections) {
        const preferred = SECTION_PALETTES[section.label], previous = palettes.at(-1);
        // Prefer the section's usual theme. Repeated or very similar hues get
        // the most contrasting existing dark palette, without a random reroll.
        palettes.push(previous && paletteSeparation(preferred, previous) < 0.45
            ? choices.reduce((best, candidate) =>
                paletteSeparation(candidate, previous) > paletteSeparation(best, previous) ? candidate : best)
            : preferred);
    }
    return palettes;
}

/**
 * A pure position sampler, not a boundary event queue. Pausing, slowing down,
 * seeking and retrying therefore cannot accumulate or replay old transitions.
 * Section boundaries use the raw song position, without visual calibration.
 */
export class SectionTransitionTimeline {
    private readonly sections: readonly SongSection[];
    private readonly palettes: readonly SectionPalette[];
    private readonly music: MusicalTimeline;
    private readonly transitions: readonly Transition[];

    constructor(structure: SectionAnalysis | undefined, beats: readonly Beat[]) {
        this.sections = (structure && validateSections(structure, structure.duration))?.sections ?? [];
        this.palettes = chooseSectionPalettes(this.sections);
        this.music = new MusicalTimeline(this.sections.length ? beats : []);
        this.transitions = this.sections.map((section, index) => {
            const startTime = section.start;
            const birth = this.music.sample(startTime);
            const fallback: Transition = {
                startTime,
                endTime: index === 0 ? startTime : Math.min(section.end, startTime + QUIET_FADE_SECONDS),
                startCoordinate: birth.beatCoordinate,
                beatSpan: 0,
                musical: false,
                anticipationStartTime: startTime,
                anticipationCoordinate: birth.beatCoordinate,
                anticipationSpan: 0,
            };
            if (index === 0 || !birth.active) return fallback;

            const endAfterBeats = (span: number): number => {
                const coordinate = birth.beatCoordinate + span;
                const targetIndex = Math.floor(coordinate);
                const before = beats[targetIndex];
                const after = beats[targetIndex + 1];
                // Ending at the last authored beat is valid; extrapolating beyond it is not.
                const targetTime = before
                    ? before.time + (after ? (after.time - before.time) * (coordinate - targetIndex) : 0)
                    : beats.at(-1)!.time;
                let endTime = Math.min(section.end, targetTime);
                for (let i = birth.beatIndex; i < beats.length - 1 && beats[i]!.time < endTime; i++) {
                    if (!this.music.sample(Math.max(startTime, beats[i]!.time)).active) {
                        endTime = Math.min(endTime, beats[i]!.time);
                        break;
                    }
                }
                return endTime;
            };
            let requestedBeats = TRANSITION_BEATS;
            let endTime = endAfterBeats(requestedBeats);
            // Slow songs use fewer real beats to keep the wave's duration bounded.
            while (endTime - startTime > MAX_TRANSITION_SECONDS && requestedBeats > 0.5) {
                requestedBeats /= 2;
                endTime = endAfterBeats(requestedBeats);
            }
            const beatSpan = this.music.sample(endTime).beatCoordinate - birth.beatCoordinate;
            // Tiny fragments use a gentle palette fade instead of a rushed wave.
            if (endTime - startTime < MIN_TRANSITION_SECONDS - EPSILON || beatSpan < 0.5 - EPSILON) return fallback;
            // Check eligibility before acceleration so fast tempos do not lose
            // their wave simply because the new travel time is shorter.
            endTime = endAfterBeats(beatSpan / WAVE_SPEED);
            return {
                ...fallback, endTime, startCoordinate: birth.beatCoordinate,
                beatSpan: this.music.sample(endTime).beatCoordinate - birth.beatCoordinate, musical: true,
            };
        });
        for (let index = 1; index < this.transitions.length; index++) {
            const transition = this.transitions[index]!;
            if (!transition.musical) continue;
            const coordinate = Math.max(0, transition.startCoordinate - ANTICIPATION_BEATS);
            const beatIndex = Math.floor(coordinate);
            const before = beats[beatIndex], after = beats[beatIndex + 1];
            if (!before || !after) continue;
            const proposed = before.time + (after.time - before.time) * (coordinate - beatIndex);
            // A charge must not overlap the preceding wave/fade or bridge missing beats.
            const start = Math.max(0, proposed, transition.startTime - MAX_ANTICIPATION_SECONDS,
                this.transitions[index - 1]!.endTime);
            if (transition.startTime - start < MIN_ANTICIPATION_SECONDS) continue;
            const birth = this.music.sample(start);
            if (!birth.active) continue;
            let valid = true;
            for (let i = birth.beatIndex; i < beats.length && beats[i]!.time < transition.startTime; i++) {
                if (!this.music.sample(Math.max(start, beats[i]!.time)).active) {
                    valid = false;
                    break;
                }
            }
            if (!valid) continue;
            transition.anticipationStartTime = start;
            transition.anticipationCoordinate = birth.beatCoordinate;
            transition.anticipationSpan = transition.startCoordinate - birth.beatCoordinate;
        }
    }

    sample(position: number): SectionTransitionFrame {
        if (!this.sections.length) {
            return {
                index: -1, label: undefined, active: false, startTime: 0, endTime: 0,
                progress: 1, waveProgress: 1, anticipating: false, anticipation: 0, impact: 0,
                envelope: 0, musical: false,
                from: DEFAULT_SECTION_PALETTE, to: DEFAULT_SECTION_PALETTE, palette: DEFAULT_SECTION_PALETTE,
            };
        }
        // During count-in (and invalid-clock recovery), establish the first palette quietly.
        const time = Number.isFinite(position) ? position : 0;
        let low = 0, high = this.sections.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.sections[middle]!.start <= time) low = middle + 1;
            else high = middle;
        }
        const index = Math.max(0, low - 1);
        const section = this.sections[index]!;
        const transition = this.transitions[index]!;
        const from = this.palettes[Math.max(0, index - 1)]!;
        const to = this.palettes[index]!;
        const { startTime, endTime, musical } = transition;
        const active = index > 0 && time >= startTime && time < endTime;
        const progress = !active ? 1 : musical
            ? clamp01((this.music.sample(time).beatCoordinate - transition.startCoordinate) / transition.beatSpan)
            : clamp01((time - startTime) / (endTime - startTime));
        const eased = smooth(progress);
        const envelope = active && musical ? Math.sin(Math.PI * progress) ** 2 : 0;
        const next = this.transitions[index + 1];
        const anticipating = !active && !!next?.anticipationSpan
            && time >= next.anticipationStartTime && time < next.startTime;
        const anticipation = anticipating
            ? smooth(clamp01((this.music.sample(time).beatCoordinate - next!.anticipationCoordinate) / next!.anticipationSpan))
            : 0;
        const impact = anticipating ? anticipation : active && musical && transition.anticipationSpan > 0
            ? 1 - smooth(clamp01((this.music.sample(time).beatCoordinate - transition.startCoordinate)
                / Math.min(1, transition.beatSpan)))
            : 0;
        return {
            index, label: section.label, active, startTime, endTime, progress, musical,
            waveProgress: eased, anticipating, anticipation, impact,
            envelope, from, to, palette: mixPalette(from, to, eased),
        };
    }
}
