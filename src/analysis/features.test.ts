import { expect, test } from "bun:test";
import { calculateEnergy, validateEnergyCurve } from "./energy";
import { createFeatureSample, sampleFeatures, validateFeatures } from "./features";

const rate = 22050;
const tone = (frequency: number, seconds = 4, amplitude = 0.5) => Float32Array.from(
    { length: rate * seconds }, (_, i) => Math.sin(i * frequency * Math.PI * 2 / rate) * amplitude,
);
const read = (pcm: Float32Array, position = 2) => {
    const curve = calculateEnergy(pcm);
    return sampleFeatures(curve.features, curve.duration, position, createFeatureSample());
};

test("FFT bands distinguish bass, mid and treble with one shared normalization", () => {
    const low = read(tone(80)), mid = read(tone(800)), high = read(tone(6000));
    const strongest = (values: number[]) => values.indexOf(Math.max(...values));
    expect(strongest(low.spectrum)).toBeLessThan(4);
    expect(strongest(mid.spectrum)).toBeGreaterThan(6);
    expect(strongest(mid.spectrum)).toBeLessThan(10);
    expect(strongest(high.spectrum)).toBeGreaterThan(12);
    expect(low.high).toBeLessThan(0.01);
    expect(low.mid).toBeLessThan(0.03);
    expect(mid.mid).toBeGreaterThan(0.9);
    expect(mid.high).toBeLessThan(0.03);
    expect(high.high).toBeGreaterThan(0.9);
});

test("silence stays dark; changes create transients and slower buildup/release envelopes", () => {
    expect(read(new Float32Array(rate * 4)).spectrum).toEqual(Array(16).fill(0));
    const pcm = new Float32Array(rate * 12);
    pcm.set(tone(800, 2, 0.08), rate);
    pcm.set(tone(800, 4, 0.5), rate * 3);
    const curve = calculateEnergy(pcm), sample = (position: number) =>
        sampleFeatures(curve.features, curve.duration, position, createFeatureSample());
    expect(sample(3.025).transient).toBeGreaterThan(sample(6).transient + 0.15);
    expect(sample(4).buildup).toBeGreaterThan(0.3);
    expect(sample(8).release).toBeGreaterThan(0.3);
    expect(sample(11.9).high).toBe(0);
    const travel = curve.features!.travel;
    for (let i = 1; i < travel.length; i++) {
        expect(travel[i]! - travel[i - 1]!).toBeGreaterThanOrEqual(0.0159);
        expect(travel[i]! - travel[i - 1]!).toBeLessThanOrEqual(0.0611);
    }
});

test("feature data is compact, validated and sampled deterministically after seeks", () => {
    const curve = calculateEnergy(tone(1200, 1)), features = curve.features!;
    expect(features.frames.byteLength + features.travel.byteLength).toBe(20 * 25);
    expect(validateEnergyCurve(curve)?.features).toEqual(features);
    expect(validateFeatures({ ...features, frames: new Uint8Array(1) }, 20)).toBeUndefined();
    expect(validateFeatures({ ...features, travel: new Float32Array(20).fill(NaN) }, 20)).toBeUndefined();
    const first = sampleFeatures(features, 1, 0.3, createFeatureSample());
    sampleFeatures(features, 1, 0.9, createFeatureSample());
    expect(sampleFeatures(features, 1, 0.3, createFeatureSample())).toEqual(first);
    for (const time of [-1, 1, Infinity, NaN]) {
        expect(sampleFeatures(features, 1, time, createFeatureSample())).toEqual(createFeatureSample());
    }
});
