import { expect, test } from "bun:test";
import {
    bloomContribution, isNeonGameplay, neonShaderSource, neonTargetDimensions, sampleNeonFrame, type NeonInput,
} from "./postprocess";

const input = (): NeonInput => ({
    visible: true, gameplay: true, intensity: "standard", reducedMotion: false, reducedFlash: false, highQuality: true,
    beatPulse: 0, downbeatPulse: 0, musicalStrength: 1, sectionActive: false, sectionProgress: 0,
});

test("highlight extraction has a smooth knee and leaves the dark arena outside the bloom", () => {
    for (const brightness of [0, 0.01, 0.08, 0.23, 0.49, 0.5]) {
        expect(bloomContribution(brightness, 0.8, 0.3)).toBe(0);
    }
    let previous = 0;
    for (let brightness = 0.51; brightness < 3; brightness += 0.01) {
        const contribution = bloomContribution(brightness, 0.8, 0.3);
        expect(contribution).toBeGreaterThanOrEqual(previous);
        expect(contribution).toBeLessThan(1);
        previous = contribution;
    }
    expect(bloomContribution(1.8, 0.8, 0.3)).toBeCloseTo(1 / 1.8, 6);
    expect(Number.isFinite(bloomContribution(0, 0.8, 0))).toBe(true);
});

test("vignette gameplay gating excludes menus, count-in, pause and the finished-track boundary", () => {
    for (const phase of ["menu", "loading", "starting", "paused", "results"]) {
        expect(isNeonGameplay(phase, 12, 120)).toBe(false);
    }
    for (const position of [-1, -0.001, NaN, Infinity, -Infinity, 120, 120.001]) {
        expect(isNeonGameplay("playing", position, 120)).toBe(false);
    }
    for (const position of [0, 0.001, 12, 119.999]) {
        expect(isNeonGameplay("playing", position, 120)).toBe(true);
    }
    for (const duration of [0, -1, NaN]) {
        expect(isNeonGameplay("playing", 0, duration)).toBe(false);
    }
});

test("leaving active gameplay removes only vignette while retaining the same bloom and chromatic frame", () => {
    const settings = { ...input(), beatPulse: 1, sectionActive: true, sectionProgress: 0.5 };
    const variants: Partial<NeonInput>[] = [{}, { intensity: "calm" }, { reducedMotion: true }, { reducedFlash: true }];
    for (const variant of variants) {
        const playing = sampleNeonFrame({ ...settings, ...variant });
        expect(playing.vignette).toBe(variant.intensity === "calm" || variant.reducedMotion || variant.reducedFlash
            ? 0.08 : 0.12);
        expect(sampleNeonFrame({ ...settings, ...variant, gameplay: false })).toEqual({
            ...playing, vignette: 0,
        });
    }
});

test("music-clock envelopes stay bounded, hold on pause and restart deterministically", () => {
    const settings = input();
    const quiet = sampleNeonFrame(settings);
    expect(quiet.bloom).toBe(0.54);
    expect(quiet.chromatic).toBe(0);
    settings.beatPulse = 1;
    settings.sectionActive = true;
    settings.sectionProgress = 0.5;
    const peak = sampleNeonFrame(settings);
    expect(peak.bloom).toBeCloseTo(0.82);
    expect(peak.chromatic).toBe(0.75);
    for (let frame = 0; frame < 30; frame++) expect(sampleNeonFrame(settings)).toEqual(peak);
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
        settings.sectionProgress = progress;
        const frame = sampleNeonFrame(settings);
        expect(frame.bloom).toBeGreaterThanOrEqual(0.54);
        expect(frame.bloom).toBeLessThanOrEqual(0.83);
        expect(frame.chromatic).toBeLessThanOrEqual(0.75);
        expect(frame.vignette).toBe(0.12);
    }
    expect(sampleNeonFrame(input())).toEqual(quiet);
    settings.musicalStrength = 0;
    settings.sectionActive = false;
    expect(sampleNeonFrame(settings)).toEqual(quiet);
});

test("Calm is restrained, Off bypasses, and reduced-motion/flash retain only steady soft bloom", () => {
    const settings = { ...input(), beatPulse: 1, sectionActive: true, sectionProgress: 0.5 };
    const calm = sampleNeonFrame({ ...settings, intensity: "calm" });
    expect(calm.bloom).toBeCloseTo(0.37);
    expect(calm.chromatic).toBe(0.18);
    for (const option of [{ reducedMotion: true }, { reducedFlash: true }]) {
        const peak = sampleNeonFrame({ ...settings, ...option });
        expect(peak.bloom).toBe(0.3);
        expect(peak.chromatic).toBe(0);
        expect(peak).toEqual(sampleNeonFrame({ ...settings, ...option, beatPulse: 0, sectionProgress: 0 }));
    }
    for (const option of [{ intensity: "off" as const }, { visible: false }]) {
        const frame = sampleNeonFrame({ ...settings, ...option });
        expect(frame.enabled).toBe(false);
        expect(frame.bloom).toBe(0);
        expect(frame.chromatic).toBe(0);
        expect(frame.vignette).toBe(0);
    }
});

test("target plans keep both detail modes sub-resolution and clamp tiny or odd view sizes", () => {
    expect(neonTargetDimensions(1920, 1080, false)).toEqual({
        width: 1920, height: 1080, extractWidth: 960, extractHeight: 540, bloomWidth: 480, bloomHeight: 270,
    });
    expect(neonTargetDimensions(1921, 1081, true)).toEqual({
        width: 1921, height: 1081, extractWidth: 481, extractHeight: 271, bloomWidth: 241, bloomHeight: 136,
    });
    for (const size of [0, 1, NaN, -2]) {
        expect(neonTargetDimensions(size, size, false)).toEqual({
            width: 1, height: 1, extractWidth: 1, extractHeight: 1, bloomWidth: 1, bloomHeight: 1,
        });
    }
});

test("all production HDR shader entries resolve, including the shared soft-knee helper", () => {
    const source = neonShaderSource();
    for (const entry of ["neonVertex", "neonExtract", "neonHorizontal", "neonVertical", "neonLowBlur", "neonComposite"]) {
        expect(source).toContain(`fn ${entry}(`);
    }
    expect(source).toContain("textureLoad(scene");
    expect(source).toContain("bloomContribution");
    // Native Vignette owns edge darkening; the custom pass retains colour separation.
    expect(source).not.toContain("vignette");
    expect(source).toContain("color.r = textureSampleLevel");
    expect(source).toContain("color.b = textureSampleLevel");
});
