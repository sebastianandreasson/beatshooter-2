import { describe, expect, test } from "bun:test";
import { createPracticeTrack, DEMO_TRACK, localTrackId, TrackLoader, validateManifest } from "./index";
import { calculateEnergy } from "../analysis/energy";
import type { SectionAnalysis } from "../analysis/sections";

describe("track manifests", () => {
    test("bundled audio manifest matches its WAV header and declared beat data", async () => {
        const bytes = await Bun.file(new URL("../../public/tracks/neon-circuit.wav", import.meta.url)).arrayBuffer();
        const data = new DataView(bytes);
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
        expect(data.getUint32(24, true)).toBe(22050);
        expect(data.getUint16(22, true)).toBe(1);
        expect(data.getUint16(34, true)).toBe(16);
        expect(data.getUint32(40, true) / 2 / 22050).toBe(DEMO_TRACK.duration);
        expect(DEMO_TRACK.beats.length).toBe(144);
        expect(DEMO_TRACK.license).toBe("CC0-1.0");
    });

    test("missing metadata and invalid timelines fail with useful errors", () => {
        expect(() => validateManifest({})).toThrow("version");
        expect(() => validateManifest({ ...DEMO_TRACK, title: "" })).toThrow("title");
        expect(() => validateManifest({ ...DEMO_TRACK, duration: NaN })).toThrow("duration");
        expect(() => validateManifest({ ...DEMO_TRACK, firstBeatOffset: 1 })).toThrow("match");
        expect(() => validateManifest({ ...DEMO_TRACK, beats: [] })).toThrow("ordered");
        expect(() => validateManifest({ ...DEMO_TRACK, beats: null })).toThrow("ordered");
        expect(() => validateManifest({ ...DEMO_TRACK, id: "Unsafe / name" })).toThrow("safe identifier");
    });

    test("practice supplies a long finite metronome at the selected tempo", () => {
        const practice = createPracticeTrack(90);
        expect(practice.duration).toBe(21_600);
        expect(practice.beats[1]!.time).toBe(60 / 90);
        validateManifest(practice);
    });
});

describe("local file loading", () => {
    test("analysis, preview and retry reuse one decoded file and content identity", async () => {
        let decodes = 0;
        const loader = new TrackLoader({
            async decodeAudioData() {
                decodes++;
                return { duration: 4, length: 192_000, numberOfChannels: 2 } as AudioBuffer;
            },
        });
        const file = new File(["audio"], "cached.wav");
        const prepared = await loader.prepareLocal(file);
        const preview = await loader.loadLocal(file, 120);
        preview.dispose();
        const game = await loader.loadLocal(file, 100, 0.1);
        expect(decodes).toBe(1);
        expect(game.buffer).toBe(prepared.buffer);
        expect(prepared.contentHash).toMatch(/^[a-f0-9]{64}$/);
        game.dispose();
        const cached = loader.prepareLocal(file);
        loader.cancel();
        await expect(cached).rejects.toMatchObject({ name: "AbortError" });
        loader.clearLocalCache();
        await loader.prepareLocal(file);
        expect(decodes).toBe(2);
        loader.dispose();
    });

    test("detected timestamps and chart identity survive loading without a BPM grid", async () => {
        const loader = new TrackLoader({
            async decodeAudioData() { return { duration: 5 } as AudioBuffer; },
        });
        const file = new File(["audio"], "detected.wav");
        const analysis = {
            schemaVersion: 1 as const, analyzerVersion: "test-1", duration: 5,
            beats: [0.2, 0.7, 1.19, 1.68, 2.16, 2.64, 3.11, 3.58, 4.04, 4.5],
            downbeats: [0.7, 2.64, 4.5], elapsedMs: 1, backend: "webgpu" as const,
            energy: calculateEnergy(new Float32Array(5 * 22_050)),
            structure: {
                version: 1, analyzerVersion: "fixture", duration: 5, elapsedMs: 1, backend: "webgpu",
                sections: [{ start: 0, end: 5, label: "intro" }],
            } satisfies SectionAnalysis,
        };
        const loaded = await loader.loadLocal(file, 120, 0, analysis);
        expect(loaded.manifest.beats.map(beat => beat.time)).toEqual(analysis.beats);
        expect(loaded.manifest.beats[0]!.downbeat).toBe(false);
        expect(loaded.energy).toEqual(analysis.energy);
        expect(loaded.energy?.loudness).not.toBe(analysis.energy.loudness);
        expect(loaded.structure).toEqual(analysis.structure);
        expect(loaded.structure?.sections[0]).not.toBe(analysis.structure.sections[0]);
        expect(loaded.manifest.id).toMatch(/^analyzed-/);
        expect(loaded.manifest.id.length).toBeLessThanOrEqual(128);
        const retry = await loader.loadLocal(file, 80, 0.3, analysis);
        expect(retry.manifest.id).toBe(loaded.manifest.id);
        const noEnergy = await loader.loadLocal(file, 120, 0, {
            ...analysis, energy: { ...analysis.energy, loudness: [NaN] },
        });
        expect(noEnergy.energy).toBeUndefined();
        expect(noEnergy.manifest.id).toBe(loaded.manifest.id);
        const noSections = await loader.loadLocal(file, 120, 0, {
            ...analysis, structure: { ...analysis.structure, duration: 6 },
        });
        expect(noSections.structure).toBeUndefined();
        expect(noSections.manifest.id).toBe(loaded.manifest.id);
        const changed = await loader.loadLocal(file, 120, 0, {
            ...analysis, beats: analysis.beats.map(time => time + 0.01),
            downbeats: analysis.downbeats.map(time => time + 0.01),
        });
        expect(changed.manifest.id).not.toBe(loaded.manifest.id);
        await expect(loader.loadLocal(file, 120, 0, { ...analysis, duration: 6 }))
            .rejects.toThrow("does not match");
        loader.dispose();
    });

    test("compressed size does not bypass the decoded PCM memory budget", async () => {
        const loader = new TrackLoader({
            async decodeAudioData() {
                return { duration: 3600, length: 3600 * 48000, numberOfChannels: 2 } as AudioBuffer;
            },
        });
        await expect(loader.prepareLocal(new File(["tiny compressed data"], "long.mp3")))
            .rejects.toThrow("too much decoded audio memory");
        loader.dispose();
    });

    test("metadata IDs stay stable and safe for names with spaces, Unicode and punctuation", async () => {
        const metadata = { name: "Björk / 夜の音楽.. final mix!.wav", size: 500, lastModified: 123456789 };
        const id = localTrackId(metadata);
        expect(id).toMatch(/^local-[0-9a-f]{16}$/);
        expect(id.length).toBeLessThanOrEqual(128);
        expect(localTrackId({ ...metadata })).toBe(id);
        expect(localTrackId({ ...metadata, size: 501 })).not.toBe(id);
        expect(localTrackId({ ...metadata, lastModified: 123456790 })).not.toBe(id);
        const loader = new TrackLoader({
            async decodeAudioData() { return { duration: 4 } as AudioBuffer; },
        });
        const file = new File(["audio"], metadata.name, { lastModified: metadata.lastModified });
        const loaded = await loader.loadLocal(file, 120);
        expect(loaded.manifest.id).toBe(localTrackId(file));
        expect(loaded.manifest.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
        expect(loaded.manifest.title).toContain("夜の音楽");
        loader.dispose();
    });

    test("audio longer than six hours reports the supported duration", async () => {
        const loader = new TrackLoader({
            async decodeAudioData() { return { duration: 21_601 } as AudioBuffer; },
        });
        await expect(loader.loadLocal(new File(["audio"], "too long.wav"), 120))
            .rejects.toThrow("no longer than 6 hours");
        loader.dispose();
    });

    test("decode failure is actionable and invalid tempo never reaches the decoder", async () => {
        let calls = 0;
        const loader = new TrackLoader({
            async decodeAudioData() { calls++; throw new Error("unknown codec"); },
        });
        const file = new File(["bad audio"], "broken.mp3");
        await expect(loader.loadLocal(file, 120)).rejects.toThrow("could not be decoded");
        await expect(loader.loadLocal(file, 0)).rejects.toThrow("tempo");
        expect(calls).toBe(1);
        loader.dispose();
    });

    test("local metadata uses decoded duration and releasing URLs is idempotent", async () => {
        const loader = new TrackLoader({
            async decodeAudioData() { return { duration: 4 } as AudioBuffer; },
        });
        const loaded = await loader.loadLocal(new File(["audio"], "My song.wav"), 100, 0.2);
        expect(loaded.manifest.title).toBe("My song");
        expect(loaded.manifest.duration).toBe(4);
        expect(loaded.manifest.beats[0]!.time).toBe(0.2);
        expect(loaded.manifest.audioUrl.startsWith("blob:")).toBe(true);
        loaded.dispose();
        loaded.dispose();
        loader.dispose();
    });

    test("superseded decoding results cannot replace the new selection", async () => {
        let finishFirst: ((buffer: AudioBuffer) => void) | undefined;
        let call = 0;
        const loader = new TrackLoader({
            decodeAudioData() {
                call++;
                if (call === 1) return new Promise((resolve) => { finishFirst = resolve; });
                return Promise.resolve({ duration: 3 } as AudioBuffer);
            },
        });
        const pending = loader.loadLocal(new File(["audio"], "first.wav"), 120);
        // Let arrayBuffer complete and enter decodeAudioData.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const latest = await loader.loadLocal(new File(["audio"], "second.wav"), 90);
        finishFirst!({ duration: 4 } as AudioBuffer);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(latest.manifest.title).toBe("second");
        loader.dispose();
    });

    test("explicit cancellation invalidates a decoder that cannot be aborted", async () => {
        let finish: ((buffer: AudioBuffer) => void) | undefined;
        const loader = new TrackLoader({
            decodeAudioData: () => new Promise((resolve) => { finish = resolve; }),
        });
        const pending = loader.loadLocal(new File(["audio"], "cancel.wav"), 120);
        await new Promise((resolve) => setTimeout(resolve, 0));
        loader.cancel();
        finish!({ duration: 4 } as AudioBuffer);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        loader.dispose();
    });
});
