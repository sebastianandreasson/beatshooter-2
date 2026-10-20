import { ANALYSIS_SAMPLE_RATE, type EnergyCurve } from "./types";
import { calculateFeatures, validateFeatures } from "./features";

export const ENERGY_SAMPLE_RATE = 20;
const SILENCE_FLOOR = 0.001; // -60 dBFS amplitude: do not amplify near-silence.
const MAX_DURATION = 21_600;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export interface EnergySample {
    loudness: number;
    bass: number;
}

/** A fixed histogram keeps normalization linear even for very long local files. */
function referenceAmplitude(values: readonly number[]): number {
    let peak = 0;
    for (const value of values) peak = Math.max(peak, value);
    if (peak <= SILENCE_FLOOR) return SILENCE_FLOOR;
    const histogram = new Uint32Array(256);
    let audible = 0;
    for (const value of values) {
        if (value <= SILENCE_FLOOR) continue;
        histogram[Math.min(255, Math.floor(value / peak * 255))]!++;
        audible++;
    }
    let remaining = Math.ceil(audible * 0.95);
    for (let index = 0; index < histogram.length; index++) {
        remaining -= histogram[index]!;
        if (remaining <= 0) return Math.max(SILENCE_FLOOR, (index + 1) / 256 * peak);
    }
    return peak;
}

function normalizeAndSmooth(values: number[], reference: number): void {
    const attack = 1 - Math.exp(-1 / ENERGY_SAMPLE_RATE / 0.15);
    const release = 1 - Math.exp(-1 / ENERGY_SAMPLE_RATE / 0.45);
    let previous = 0;
    for (let index = 0; index < values.length; index++) {
        const value = values[index]!;
        const target = value <= SILENCE_FLOOR ? 0
            : Math.sqrt(clamp((value - SILENCE_FLOOR) / Math.max(SILENCE_FLOOR, reference - SILENCE_FLOOR)));
        previous += (target - previous) * (target > previous ? attack : release);
        values[index] = previous < 0.0001 ? 0 : clamp(previous);
    }
}

/**
 * RMS and bass use one bounded pass over already-owned mono PCM. A 20 Hz
 * high-pass and two 180 Hz low-pass poles estimate bass. These and the subsequent
 * 20 Hz FFT features share the track's 95th-percentile RMS reference, so a
 * high-frequency-only track cannot normalize its bass to full.
 * Input is only read; inference receives exactly the original PCM.
 */
export function calculateEnergy(pcm: Float32Array, sampleRate = ANALYSIS_SAMPLE_RATE): EnergyCurve {
    const duration = pcm.length / sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 192_000 ||
        !pcm.length || !Number.isFinite(duration) || duration > MAX_DURATION) {
        throw new Error("Energy analysis needs finite mono audio no longer than six hours.");
    }
    const length = Math.ceil(duration * ENERGY_SAMPLE_RATE);
    const loudness = new Array<number>(length);
    const bass = new Array<number>(length);
    const highAlpha = Math.exp(-2 * Math.PI * 20 / sampleRate);
    const lowAlpha = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate);
    let previous = 0, high = 0, low1 = 0, low2 = 0;
    let start = 0;
    for (let frame = 0; frame < length; frame++) {
        const end = Math.min(pcm.length, Math.floor((frame + 1) * sampleRate / ENERGY_SAMPLE_RATE));
        let sum = 0, lowSum = 0;
        for (let index = start; index < end; index++) {
            const raw = pcm[index]!;
            const sample = Number.isFinite(raw) ? Math.min(1, Math.max(-1, raw)) : 0;
            high = highAlpha * (high + sample - previous);
            previous = sample;
            low1 += lowAlpha * (high - low1);
            low2 += lowAlpha * (low1 - low2);
            sum += sample * sample;
            lowSum += low2 * low2;
        }
        const count = Math.max(1, end - start);
        loudness[frame] = Math.sqrt(sum / count);
        bass[frame] = Math.sqrt(lowSum / count);
        start = end;
    }
    const reference = referenceAmplitude(loudness);
    normalizeAndSmooth(loudness, reference);
    normalizeAndSmooth(bass, reference);
    return {
        version: 1, sampleRate: ENERGY_SAMPLE_RATE, duration, loudness, bass,
        features: calculateFeatures(pcm, sampleRate, reference, loudness),
    };
}

/** Reject optional malformed decoration without preventing a valid chart from playing. */
export function validateEnergyCurve(value: unknown, expectedDuration?: number): EnergyCurve | undefined {
    if (!value || typeof value !== "object") return undefined;
    const source = value as Record<string, unknown>;
    if (source.version !== 1 || source.sampleRate !== ENERGY_SAMPLE_RATE ||
        typeof source.duration !== "number" || !Number.isFinite(source.duration) ||
        source.duration <= 0 || source.duration > MAX_DURATION ||
        (expectedDuration !== undefined && (!Number.isFinite(expectedDuration) ||
            Math.abs(source.duration - expectedDuration) > 0.05))) return undefined;
    const length = Math.ceil(source.duration * ENERGY_SAMPLE_RATE);
    const valid = (curve: unknown): curve is number[] => {
        if (!Array.isArray(curve) || curve.length !== length) return false;
        for (let index = 0; index < length; index++) {
            const value = curve[index];
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
        }
        return true;
    };
    if (!valid(source.loudness) || !valid(source.bass)) return undefined;
    return {
        version: 1, sampleRate: ENERGY_SAMPLE_RATE, duration: source.duration,
        loudness: source.loudness.slice(), bass: source.bass.slice(),
        ...(source.features ? { features: validateFeatures(source.features, length) } : {}),
    };
}

/** Stateless interpolation makes pause, seek and repeated renders deterministic. */
export function sampleEnergy(curve: EnergyCurve | undefined, position: number): EnergySample {
    if (!Number.isFinite(position)) return { loudness: 0, bass: 0 };
    if (!curve) return { loudness: 0.5, bass: 0.5 };
    if (position < 0 || position >= curve.duration) return { loudness: 0, bass: 0 };
    const coordinate = Math.max(0, position * curve.sampleRate - 0.5);
    const index = Math.min(curve.loudness.length - 1, Math.floor(coordinate));
    const next = Math.min(curve.loudness.length - 1, index + 1);
    const phase = coordinate - index;
    return {
        loudness: curve.loudness[index]! + (curve.loudness[next]! - curve.loudness[index]!) * phase,
        bass: curve.bass[index]! + (curve.bass[next]! - curve.bass[index]!) * phase,
    };
}
