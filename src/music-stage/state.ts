import type { FeatureSample } from "../analysis/features";
import type { SectionLabel } from "../analysis/sections";
import type { EnergySample } from "../analysis/energy";
import type { MusicalFrame } from "../rhythm/visual";

export interface Arrangement {
    spectrum: number; lasers: number; aurora: number; echoes: number; geometry: number; sides: number;
}
export const ARRANGEMENTS: Readonly<Record<SectionLabel, Arrangement>> = {
    intro:   { spectrum: 0.45, lasers: 0,    aurora: 0.3,  echoes: 0.12, geometry: 0.25, sides: 4 },
    verse:   { spectrum: 1,    lasers: 0.25, aurora: 0.35, echoes: 0.35, geometry: 0.5,  sides: 6 },
    chorus:  { spectrum: 1,    lasers: 1,    aurora: 0.7,  echoes: 1,    geometry: 1,    sides: 8 },
    bridge:  { spectrum: 0.5,  lasers: 0.12, aurora: 1,    echoes: 0.5,  geometry: 0.6,  sides: 12 },
    inst:    { spectrum: 0.85, lasers: 0.65, aurora: 0.65, echoes: 0.65, geometry: 0.7,  sides: 6 },
    outro:   { spectrum: 0.4,  lasers: 0,    aurora: 0.65, echoes: 0.2,  geometry: 0.3,  sides: 4 },
    silence: { spectrum: 0,    lasers: 0,    aurora: 0,    echoes: 0,    geometry: 0,    sides: 12 },
};
export const clamp = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const smooth = (value: number): number => { const p = clamp(value); return p * p * (3 - 2 * p); };

export interface StageFrame {
    enabled: boolean; moving: boolean; low: boolean;
    gain: number; energy: number; bass: number; mid: number; high: number;
    accent: number; buildup: number; release: number;
    travel: number; beat: number; bar: number; opening: number;
    arrangement: Arrangement; fromSides: number; shapeBlend: number;
}

export function sampleStageFrame(input: {
    visible: boolean; intensity: number; motionAllowed: boolean; highQuality: boolean;
    label?: SectionLabel; previousLabel?: SectionLabel; sectionAge: number; sectionImpact: number;
    music: MusicalFrame; energy: EnergySample; features: FeatureSample; hasFeatures: boolean;
}): StageFrame {
    const to = ARRANGEMENTS[input.label ?? "inst"], from = ARRANGEMENTS[input.previousLabel ?? input.label ?? "inst"];
    const blend = smooth(input.sectionAge / 1.5);
    const arrangement = { ...to };
    for (const key of ["spectrum", "lasers", "aurora", "echoes", "geometry"] as const) {
        arrangement[key] = from[key] + (to[key] - from[key]) * blend;
    }
    const moving = input.visible && input.motionAllowed;
    const energy = clamp(input.energy.loudness), features = input.features;
    return {
        enabled: input.visible && input.intensity > 0,
        moving, low: !input.highQuality,
        gain: input.visible ? clamp(input.intensity) : 0,
        energy, bass: clamp(input.energy.bass),
        mid: input.hasFeatures ? features.mid : energy * 0.45,
        high: input.hasFeatures ? features.high : energy * 0.2,
        accent: moving ? clamp(input.music.beatPulse * input.music.strength * input.energy.bass * 0.6
            + features.transient * 0.4) : 0,
        buildup: moving ? features.buildup : 0,
        release: moving ? features.release : 0,
        travel: moving ? (input.hasFeatures ? features.travel : Math.max(0, input.music.position) * 0.6) : 0,
        beat: moving ? input.music.beatCoordinate : 0,
        bar: moving ? input.music.barCoordinate : 0,
        opening: moving ? clamp(input.sectionImpact) * energy : 0,
        arrangement, fromSides: from.sides, shapeBlend: blend,
    };
}

/** A regular polygon sampled radially; 24 shared vertices allow continuous morphs. */
export function polygonRadius(angle: number, sides: number): number {
    const sector = Math.PI * 2 / sides;
    const local = ((angle + sector / 2) % sector + sector) % sector - sector / 2;
    return Math.cos(Math.PI / sides) / Math.cos(local);
}

/** Bounded absolute position, not velocity * current energy (which would jump). */
export function auroraPoint(travel: number, lane: number, angle: number, spread: number): [number, number] {
    const bend = Math.sin(angle * 3 + travel * 0.22 + lane * 2) * (1.2 + spread);
    const radius = 25 + lane * 2.6 + bend;
    return [
        Math.cos(angle) * radius,
        Math.sin(angle) * radius * 0.88 + Math.sin(angle * 2 - travel * 0.18) * 1.1,
    ];
}
