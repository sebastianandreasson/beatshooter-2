import { describe, expect, test } from "bun:test";
import { calculateEnergy, sampleEnergy, validateEnergyCurve } from "./energy";
import type { EnergyCurve } from "./types";

const rate = 22_050;
function tone(frequency: number, duration = 3, amplitude = 0.5): Float32Array {
    return Float32Array.from({ length: Math.floor(rate * duration) },
        (_, index) => Math.sin(index / rate * Math.PI * 2 * frequency) * amplitude);
}

describe("local visual energy", () => {
    test("silence and signals below the silence floor stay dark", () => {
        for (const pcm of [new Float32Array(rate), tone(60, 1, 0.0001)]) {
            const curve = calculateEnergy(pcm);
            expect(curve.loudness).toEqual(new Array(20).fill(0));
            expect(curve.bass).toEqual(new Array(20).fill(0));
        }
    });

    test("bass distinguishes equal-volume low and high tones without changing source PCM", () => {
        const pcm = tone(60);
        const original = pcm.slice();
        const low = calculateEnergy(pcm);
        const high = calculateEnergy(tone(2000));
        expect(pcm).toEqual(original);
        expect(low.loudness.length).toBe(60);
        expect(sampleEnergy(low, 2).loudness).toBeGreaterThan(0.95);
        expect(sampleEnergy(high, 2).loudness).toBeGreaterThan(0.95);
        expect(sampleEnergy(low, 2).bass).toBeGreaterThan(0.8);
        expect(sampleEnergy(high, 2).bass).toBeLessThan(0.15);
    });

    test("quiet passages settle and smoothing limits abrupt changes", () => {
        const pcm = new Float32Array(rate * 5);
        pcm.set(tone(60, 2));
        const curve = calculateEnergy(pcm);
        expect(sampleEnergy(curve, 1.9).loudness).toBeGreaterThan(0.95);
        expect(sampleEnergy(curve, 4.9).loudness).toBeLessThan(0.002);
        for (let index = 1; index < curve.loudness.length; index++) {
            expect(Math.abs(curve.loudness[index]! - curve.loudness[index - 1]!)).toBeLessThan(0.29);
        }
        expect(validateEnergyCurve(curve, 5)).toEqual(curve);
    });

    test("frame size includes a partial ending window and finite malformed PCM is bounded", () => {
        const pcm = new Float32Array(2206);
        pcm.fill(5);
        pcm[0] = NaN;
        pcm[1] = Infinity;
        const curve = calculateEnergy(pcm);
        expect(curve.loudness.length).toBe(3);
        expect(curve.duration).toBe(2206 / rate);
        expect(validateEnergyCurve(curve)).toBeDefined();
        expect(() => calculateEnergy(new Float32Array())).toThrow("finite mono");
        expect(() => calculateEnergy(pcm, 0)).toThrow("finite mono");
    });

    test("sampling is stateless with linear interpolation and neutral missing data", () => {
        const curve: EnergyCurve = {
            version: 1, sampleRate: 20, duration: 0.1, loudness: [0, 1], bass: [1, 0],
        };
        expect(sampleEnergy(curve, 0.025)).toEqual({ loudness: 0, bass: 1 });
        expect(sampleEnergy(curve, 0.05)).toEqual({ loudness: 0.5, bass: 0.5 });
        expect(sampleEnergy(curve, 0.075)).toEqual({ loudness: 1, bass: 0 });
        for (const position of [-1, 0.1, 10, NaN]) {
            expect(sampleEnergy(curve, position)).toEqual({ loudness: 0, bass: 0 });
        }
        expect(sampleEnergy(undefined, 2)).toEqual({ loudness: 0.5, bass: 0.5 });
        // Sampling earlier after a seek gives the same answer; no retained envelope clock.
        sampleEnergy(curve, 0.09);
        expect(sampleEnergy(curve, 0.05)).toEqual({ loudness: 0.5, bass: 0.5 });
    });

    test("untrusted optional metadata cannot inject nonfinite or mismatched curves", () => {
        const curve = calculateEnergy(tone(60, 0.1));
        const valid = validateEnergyCurve(curve, 0.1)!;
        expect(valid).toEqual(curve);
        expect(valid.loudness).not.toBe(curve.loudness);
        for (const patch of [
            { version: 2 }, { sampleRate: 60 }, { duration: Infinity }, { duration: 0 },
            { loudness: [NaN, 0] }, { bass: [1, 2] }, { bass: [1] }, { bass: {} },
            { bass: new Array(2) },
        ]) {
            expect(validateEnergyCurve({ ...curve, ...patch })).toBeUndefined();
        }
        expect(validateEnergyCurve(curve, 1)).toBeUndefined();
        expect(validateEnergyCurve(curve, NaN)).toBeUndefined();
        expect(validateEnergyCurve(null)).toBeUndefined();
    });
});
