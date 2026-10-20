import { fftRadix2InPlace } from "./vendor/linkseg/fft-radix2";

export const SPECTRUM_BANDS = 16;
const STRIDE = SPECTRUM_BANDS + 5;
const RATE = 20;
const FFT_SIZE = 2048;
const FLOOR = 0.001;
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** 21 bytes/frame, plus integrated travel. Under 11 MB for the six-hour limit. */
export interface VisualFeatures {
    version: 1;
    bands: 16;
    frames: Uint8Array;
    travel: Float32Array;
}

export interface FeatureSample {
    spectrum: number[];
    mid: number;
    high: number;
    transient: number;
    buildup: number;
    release: number;
    travel: number;
}

export function createFeatureSample(): FeatureSample {
    return { spectrum: Array(SPECTRUM_BANDS).fill(0), mid: 0, high: 0, transient: 0, buildup: 0, release: 0, travel: 0 };
}

/**
 * Fixed Hann FFT at 20 Hz, shared loudness reference (never per-band auto gain).
 * Transients measure positive spectral flux. Short vs long energy envelopes
 * describe sustained rises/falls. These are decoration, never beat predictions.
 */
export function calculateFeatures(
    pcm: Float32Array, sampleRate: number, reference: number, loudness: readonly number[],
): VisualFeatures {
    const count = loudness.length;
    const frames = new Uint8Array(count * STRIDE), travel = new Float32Array(count);
    const fft = new Float32Array(FFT_SIZE * 2), window = new Float32Array(FFT_SIZE);
    const binBand = new Int8Array(FFT_SIZE / 2 + 1);
    const powers = new Float64Array(SPECTRUM_BANDS + 2);
    const previous = new Float64Array(SPECTRUM_BANDS + 2);
    const smoothed = new Float64Array(SPECTRUM_BANDS + 2);
    for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_SIZE));
    for (let bin = 0; bin < binBand.length; bin++) {
        const frequency = bin * sampleRate / FFT_SIZE;
        binBand[bin] = frequency < 40 || frequency > 10_000 ? -1
            : Math.min(15, Math.floor(Math.log(frequency / 40) / Math.log(250) * SPECTRUM_BANDS));
    }
    const normalize = (power: number) => {
        const rms = Math.sqrt(power * 2 / (FFT_SIZE * FFT_SIZE * 0.375));
        return rms <= FLOOR ? 0 : Math.sqrt(unit((rms - FLOOR) / Math.max(FLOOR, reference - FLOOR)));
    };
    let short = loudness[0] ?? 0, long = short, transient = 0, distance = 0;
    for (let frame = 0; frame < count; frame++) {
        const center = Math.floor((frame + 0.5) * sampleRate / RATE);
        for (let i = 0; i < FFT_SIZE; i++) {
            const raw = pcm[center + i - FFT_SIZE / 2] ?? 0;
            fft[i * 2] = (Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0) * window[i]!;
            fft[i * 2 + 1] = 0;
        }
        fftRadix2InPlace(fft, FFT_SIZE);
        powers.fill(0);
        for (let bin = 1; bin < binBand.length; bin++) {
            const power = fft[bin * 2]! ** 2 + fft[bin * 2 + 1]! ** 2;
            const band = binBand[bin]!, frequency = bin * sampleRate / FFT_SIZE;
            if (band >= 0) powers[band]! += power;
            if (frequency >= 250 && frequency < 2000) powers[16]! += power;
            if (frequency >= 2000) powers[17]! += power;
        }
        let flux = 0;
        const offset = frame * STRIDE;
        for (let band = 0; band < powers.length; band++) {
            const value = normalize(powers[band]!);
            if (band < SPECTRUM_BANDS) flux += Math.max(0, value - previous[band]!);
            previous[band] = value;
            smoothed[band]! += (value - smoothed[band]!) * (value > smoothed[band]! ? 0.56 : 0.19);
            frames[offset + band] = Math.round(unit(smoothed[band]!) * 255);
        }
        transient = Math.max(unit(flux * 0.6), transient * 0.6);
        const energy = loudness[frame]!;
        short += (energy - short) * (1 - Math.exp(-1 / RATE / 0.7));
        long += (energy - long) * (1 - Math.exp(-1 / RATE / 3.5));
        frames[offset + 18] = Math.round(transient * 255);
        frames[offset + 19] = Math.round(unit((short - long) * 3) * 255);
        frames[offset + 20] = Math.round(unit((long - short) * 3) * 255);
        // Integrating once avoids position jumps when instantaneous energy changes.
        distance += (0.32 + energy * 0.9) / RATE;
        travel[frame] = distance;
    }
    return { version: 1, bands: SPECTRUM_BANDS, frames, travel };
}

export function validateFeatures(value: unknown, count: number): VisualFeatures | undefined {
    if (!value || typeof value !== "object") return;
    const data = value as VisualFeatures;
    if (data.version !== 1 || data.bands !== SPECTRUM_BANDS ||
        !(data.frames instanceof Uint8Array) || data.frames.length !== count * STRIDE ||
        !(data.travel instanceof Float32Array) || data.travel.length !== count) return;
    let previous = 0;
    for (const distance of data.travel) {
        if (!Number.isFinite(distance) || distance < previous || distance > count / RATE * 1.23) return;
        previous = distance;
    }
    return { version: 1, bands: SPECTRUM_BANDS, frames: data.frames.slice(), travel: data.travel.slice() };
}

/** Caller-owned scratch prevents spectrum arrays being allocated every render. */
export function sampleFeatures(
    features: VisualFeatures | undefined, duration: number, position: number, out: FeatureSample,
): FeatureSample {
    out.spectrum.fill(0);
    out.mid = out.high = out.transient = out.buildup = out.release = out.travel = 0;
    if (!features || !Number.isFinite(position) || position < 0 || position >= duration) return out;
    const coordinate = Math.max(0, position * RATE - 0.5);
    const index = Math.min(features.travel.length - 1, Math.floor(coordinate));
    const next = Math.min(features.travel.length - 1, index + 1), phase = coordinate - index;
    const read = (lane: number) => (
        features.frames[index * STRIDE + lane]! * (1 - phase) + features.frames[next * STRIDE + lane]! * phase
    ) / 255;
    for (let band = 0; band < SPECTRUM_BANDS; band++) out.spectrum[band] = read(band);
    out.mid = read(16); out.high = read(17); out.transient = read(18);
    out.buildup = read(19); out.release = read(20);
    out.travel = features.travel[index]! * (1 - phase) + features.travel[next]! * phase;
    return out;
}
