import { readFile } from "node:fs/promises";
import { expect, test } from "playwright/test";
import { transformWithOxc } from "vite";
import type { MusicTransport, TransportObservation } from "../src/rhythm/transport";
import type { Beat } from "../src/rhythm/timeline";
import type { TrackManifest } from "../src/tracks";

interface RhythmHarness {
    context: AudioContext;
    analyser: AnalyserNode;
    transport: MusicTransport;
    observed: { index: number; observedTime: number; scheduledTime: number }[];
    last: TransportObservation;
    peak: number;
    completions: number;
    immediateResume?: boolean;
    resumeStartedAt?: number;
    error?: string;
    generateTimeline: (duration: number, bpm: number, offset?: number) => Beat[];
}

declare global {
    interface Window { rhythmHarness: RhythmHarness; }
}

let transportModule = "";
let timelineModule = "";

test.beforeAll(async () => {
    // Serve the actual production source through a test-only route. No harness
    // or test globals are included in the shipped application.
    const timelineSource = await readFile(new URL("../src/rhythm/timeline.ts", import.meta.url), "utf8");
    const transportSource = await readFile(new URL("../src/rhythm/transport.ts", import.meta.url), "utf8");
    timelineModule = (await transformWithOxc(timelineSource, "timeline.ts")).code;
    transportModule = (await transformWithOxc(transportSource, "transport.ts")).code
        .replaceAll('"./timeline"', '"/__rhythm/timeline.js"');
});

test.beforeEach(async ({ page }) => {
    await page.route("**/__rhythm/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("transport.js") || path.endsWith("timeline.js")) {
            await route.fulfill({
                contentType: "application/javascript",
                body: path.endsWith("transport.js") ? transportModule : timelineModule,
            });
        } else {
            await route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><title>Rhythm integration harness</title><button id="start">Enable audio</button><button id="resume">Resume audio</button>',
            });
        }
    });
    await page.goto("/__rhythm/index.html");
    await page.evaluate(async () => {
        const transportPath = "/__rhythm/transport.js", timelinePath = "/__rhythm/timeline.js";
        const { MusicTransport } = await import(transportPath) as typeof import("../src/rhythm/transport");
        const { generateTimeline } = await import(timelinePath) as typeof import("../src/rhythm/timeline");
        const context = new AudioContext({ latencyHint: "interactive" });
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.connect(context.destination);
        const transport = new MusicTransport(context, analyser);
        transport.setVolumes({ master: 0.2 });
        const harness: RhythmHarness = {
            context, analyser, transport, generateTimeline, observed: [], peak: 0, completions: 0,
            last: { position: 0, visualPosition: 0, beats: [], completed: false },
        };
        window.rhythmHarness = harness;
        document.querySelector("#start")!.addEventListener("click", async () => {
            try {
                await context.resume();
                await transport.start({
                    duration: 4, bpm: 120, beats: generateTimeline(4, 120),
                    countInBeats: 0, metronome: true,
                });
            } catch (error) { harness.error = String(error); }
        });
        document.querySelector("#resume")!.addEventListener("click", async () => {
            try {
                await context.resume();
                harness.resumeStartedAt = context.currentTime;
                await transport.resume({ immediate: harness.immediateResume });
            } catch (error) { harness.error = String(error); }
        });
        const samples = new Float32Array(analyser.fftSize);
        const frame = () => {
            harness.last = transport.observe();
            for (const beat of harness.last.beats) {
                harness.observed.push({
                    index: beat.index, observedTime: context.currentTime,
                    scheduledTime: beat.scheduledTime,
                });
            }
            if (harness.last.completed) harness.completions++;
            analyser.getFloatTimeDomainData(samples);
            for (const sample of samples) harness.peak = Math.max(harness.peak, Math.abs(sample));
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
        window.rhythmHarness.transport.dispose();
        await window.rhythmHarness.context.close();
    });
});

test("real Web Audio metronome has signal and preserves beat ordering across pause, suspension, seek and restart", async ({ page }) => {
    await page.locator("#start").click();
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.peak)).toBeGreaterThan(0.005);
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.observed.length)).toBeGreaterThanOrEqual(2);
    const timing = await page.evaluate(() => {
        const h = window.rhythmHarness;
        h.transport.pause("hidden");
        return { accepted: h.observed, position: h.transport.position, error: h.error };
    });
    expect(timing.error).toBeUndefined();
    expect(timing.accepted.map((beat) => beat.index)).toEqual(timing.accepted.map((_, i) => i));
    for (const beat of timing.accepted) {
        expect(beat.observedTime).toBeGreaterThanOrEqual(beat.scheduledTime);
        expect(beat.observedTime - beat.scheduledTime).toBeLessThan(0.2);
    }
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.rhythmHarness.transport.position)).toBe(timing.position);
    expect(await page.evaluate(() => window.rhythmHarness.observed.length)).toBe(timing.accepted.length);
    await page.locator("#resume").click();
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.observed.length)).toBeGreaterThan(timing.accepted.length);

    await page.evaluate(() => window.rhythmHarness.context.suspend());
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.last.pausedReason)).toBe("suspended");
    await page.locator("#resume").click();
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.transport.state)).toBe("playing");
    await page.evaluate(() => window.rhythmHarness.transport.seek(3.8));
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.completions)).toBe(1);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.rhythmHarness.completions)).toBe(1);
    await page.evaluate(async () => {
        const h = window.rhythmHarness;
        h.observed.length = 0;
        await h.transport.restart();
    });
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.observed.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.rhythmHarness.observed[0]!.index)).toBe(0);
});

test("real music playback slows in pitch, pauses on the selected beat, and resumes without repeated beats", async ({ page }) => {
    await page.locator("#start").click();
    await page.evaluate(async () => {
        const h = window.rhythmHarness;
        const buffer = h.context.createBuffer(1, h.context.sampleRate * 4, h.context.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = 0.25 * Math.sin(2 * Math.PI * 880 * i / buffer.sampleRate);
        }
        h.analyser.fftSize = 4096;
        h.analyser.smoothingTimeConstant = 0;
        h.observed.length = 0;
        await h.transport.start({
            duration: 4, bpm: 120, beats: h.generateTimeline(4, 120),
            countInBeats: 0, buffer,
        });
    });
    const frequency = () => page.evaluate(() => {
        const { analyser, context } = window.rhythmHarness;
        const bins = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(bins);
        let peak = 1;
        for (let i = 2; i < bins.length; i++) if (bins[i]! > bins[peak]!) peak = i;
        return peak * context.sampleRate / analyser.fftSize;
    });
    await expect.poll(frequency).toBeGreaterThan(820);
    const normalFrequency = await frequency();
    expect(normalFrequency).toBeLessThan(940);
    const transition = await page.evaluate(() => {
        const h = window.rhythmHarness;
        const startPosition = h.transport.position, startTime = h.context.currentTime;
        return {
            accepted: h.transport.beginSlowdown(1.5),
            stopTime: startTime + 2 * (1.5 - startPosition) / 1.12,
        };
    });
    expect(transition.accepted).toBe(true);
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.transport.playbackRate)).toBeLessThan(0.65);
    const slowed = await page.evaluate(() => ({
        rate: window.rhythmHarness.transport.playbackRate,
        position: window.rhythmHarness.transport.position,
        progress: window.rhythmHarness.transport.slowdownProgress,
    }));
    const slowedFrequency = await frequency();
    expect(slowed.rate).toBeGreaterThan(0.2);
    expect(slowed.progress).toBeGreaterThan(0);
    expect(slowed.progress).toBeLessThan(1);
    expect(slowedFrequency).toBeLessThan(normalFrequency * 0.8);
    expect(Math.abs(slowedFrequency - 880 * slowed.rate)).toBeLessThan(100);
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.transport.state)).toBe("paused");
    const paused = await page.evaluate(() => ({
        position: window.rhythmHarness.transport.position,
        observed: window.rhythmHarness.observed,
        reason: window.rhythmHarness.last.pausedReason,
        rate: window.rhythmHarness.transport.playbackRate,
    }));
    expect(paused.position).toBe(1.5);
    expect(paused.reason).toBe("upgrade");
    expect(paused.rate).toBe(0);
    expect(paused.observed.map((beat) => beat.index)).toEqual([0, 1, 2, 3]);
    expect(paused.observed.at(-1)!.scheduledTime).toBeCloseTo(transition.stopTime, 5);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.rhythmHarness.transport.position)).toBe(1.5);
    await page.evaluate(() => { window.rhythmHarness.immediateResume = true; });
    await page.locator("#resume").click();
    await expect.poll(() => page.evaluate(() => {
        const h = window.rhythmHarness;
        return h.context.currentTime - h.resumeStartedAt!;
    })).toBeGreaterThan(0.01);
    const resumed = await page.evaluate(() => {
        const h = window.rhythmHarness;
        return {
            musicElapsed: h.transport.position - 1.5,
            audioElapsed: h.context.currentTime - h.resumeStartedAt!,
        };
    });
    // No 40ms silent lead-in may let gameplay advance ahead of the music.
    expect(resumed.musicElapsed).toBeCloseTo(resumed.audioElapsed, 2);
    await expect.poll(frequency).toBeGreaterThan(820);
    await expect.poll(() => page.evaluate(() => window.rhythmHarness.observed.length)).toBeGreaterThan(4);
    expect(await page.evaluate(() => window.rhythmHarness.observed.map((beat) => beat.index)))
        .toEqual([0, 1, 2, 3, 4]);
});

test("bundled WAV decodes in browser and its authored downbeats have audible energy", async ({ page }) => {
    const audio = await page.evaluate(async () => {
        const manifest = await (await fetch("/tracks/neon-circuit.json")).json() as TrackManifest;
        const bytes = await (await fetch("/tracks/neon-circuit.wav")).arrayBuffer();
        const buffer = await window.rhythmHarness.context.decodeAudioData(bytes);
        const pcm = buffer.getChannelData(0);
        const energy = (time: number) => {
            let sum = 0;
            const start = Math.floor(time * buffer.sampleRate);
            const end = Math.min(pcm.length, start + Math.floor(buffer.sampleRate * 0.08));
            for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
            return Math.sqrt(sum / (end - start));
        };
        return {
            duration: buffer.duration,
            authoredDuration: manifest.duration,
            beats: manifest.beats.length,
            firstBeat: manifest.beats[0]!.time,
            downbeatEnergy: manifest.beats.filter(beat => beat.downbeat).map(beat => energy(beat.time)),
            userAgent: navigator.userAgent,
            sampleRate: window.rhythmHarness.context.sampleRate,
        };
    });
    expect(audio.duration).toBe(72);
    expect(audio.duration).toBe(audio.authoredDuration);
    expect(audio.beats).toBe(144);
    expect(audio.firstBeat).toBe(0);
    expect(Math.min(...audio.downbeatEnergy)).toBeGreaterThan(0.05);
    test.info().annotations.push({
        type: "audio-environment",
        description: `${audio.userAgent}; AudioContext ${audio.sampleRate} Hz. Signal/scheduling verification; perceived hardware latency requires listening.`,
    });
});
