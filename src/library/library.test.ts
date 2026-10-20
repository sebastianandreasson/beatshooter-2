import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { BeatAnalysis } from "../analysis/types";
import { createRun, abandonRun } from "../run/model";
import { MusicLibrary, type LibraryOptions } from ".";
import { openLibraryDatabase, readAll, readRecord, requestResult, withTransaction } from "./database";
import { importRecovery, parseRecovery } from "./recovery";
import type { AudioRecord, ChartRevision, LibraryTrack } from "./types";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function file(bytes = [1, 2, 3], name = "pulse.wav"): File {
    return new File([new Uint8Array(bytes)], name, { type: "audio/wav", lastModified: 10 });
}
function audio(duration = 4): AudioBuffer {
    return { duration, sampleRate: 8000, length: duration * 8000, numberOfChannels: 1,
        getChannelData: () => new Float32Array(duration * 8000),
        copyFromChannel: () => {}, copyToChannel: () => {} } satisfies AudioBuffer;
}
function analysis(duration = 4): BeatAnalysis {
    return { schemaVersion: 1, analyzerVersion: "fixture-v1", duration, elapsedMs: 1, backend: "wasm",
        beats: Array.from({ length: duration * 2 }, (_, i) => i * 0.5), downbeats: [0, 2] };
}
async function database(): Promise<IDBDatabase> {
    const db = await openLibraryDatabase(new IDBFactory(), `library-${crypto.randomUUID()}`);
    cleanups.push(() => db.close());
    return db;
}
async function library(options: Partial<LibraryOptions> = {}): Promise<MusicLibrary> {
    const lib = new MusicLibrary({ database: await database(), broadcast: false,
        getDecoder: () => ({ decodeAudioData: async () => audio() }), analyze: async () => analysis(), ...options });
    cleanups.push(() => lib.dispose());
    await lib.initialize();
    await lib.setGameplayActive(true);
    return lib;
}
async function eventually(condition: () => boolean, timeout = 2000): Promise<void> {
    const end = Date.now() + timeout;
    while (!condition()) {
        if (Date.now() > end) throw new Error("Timed out waiting for library state.");
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
async function readyTrack(lib: MusicLibrary, original = file()): Promise<LibraryTrack> {
    return lib.persistAnalyzed(original, analysis());
}

describe("persistent library", () => {
    test("byte-identical files deduplicate, renamed recordings stay separate, and bad files do not discard a batch", async () => {
        let decodes = 0;
        const lib = await library({ getDecoder: () => ({ decodeAudioData: async () => { decodes++; return audio(); } }) });
        const results = await lib.importFiles([file(), file([1, 2, 3], "renamed.mp3"), file([4, 5], "pulse.wav"), file([], "empty.wav")]);
        expect(results[0]!.duplicate).toBe(false);
        expect(results[1]!.duplicate).toBe(true);
        expect(results[1]!.track!.id).toBe(results[0]!.track!.id);
        expect(results[2]!.track!.id).not.toBe(results[0]!.track!.id);
        expect(results[3]!.error).toContain("nonempty");
        expect(lib.snapshot.tracks).toHaveLength(2);
        expect(await readAll(lib.database!, "audio")).toHaveLength(2);
        expect(decodes).toBe(0);
    });

    test("analysis failure retains original; manual timing and reload play without inference", async () => {
        let inferences = 0, decodes = 0;
        const db = await database();
        const lib = await library({ database: db,
            getDecoder: () => ({ decodeAudioData: async () => { decodes++; return audio(); } }),
            analyze: async () => { inferences++; throw new Error("GPU unavailable"); },
        });
        const [imported] = await lib.importFiles([file()]);
        await lib.setGameplayActive(false);
        await eventually(() => lib.snapshot.tracks[0]?.status === "needs-timing");
        expect(await readRecord<AudioRecord>(db, "audio", imported!.track!.id)).toBeDefined();
        expect(lib.snapshot.tracks[0]!.duration).toBe(4);
        expect(lib.snapshot.tracks[0]!.error).toContain("GPU unavailable");
        const manual = await lib.manualTiming(imported!.track!.id, 130, 0.2);
        expect(manual.status).toBe("ready");
        expect(manual.bpm).toBe(130);
        expect(decodes).toBe(1); // Failed analysis already learned the duration.
        lib.dispose();
        const reopened = await library({ database: db, analyze: async () => { throw new Error("Must not analyze"); } });
        const loaded = await reopened.loadRevision(manual.chartId!);
        expect(loaded.manifest.bpm).toBe(130);
        expect(loaded.manifest.firstBeatOffset).toBe(0.2);
        expect(loaded.manifest.audioUrl.startsWith("blob:")).toBe(true);
        expect(inferences).toBe(1);
        loaded.dispose(); loaded.dispose();
    });

    test("manual Quick Play persists timing without allocating another decoded buffer", async () => {
        const lib = await library({ getDecoder: () => { throw new Error("Must not decode"); } });
        const original = await lib.persistOriginal(file());
        expect(original.status).toBe("needs-timing");
        const track = await lib.persistAnalyzed(file(), undefined, { bpm: 120, offset: 0, duration: 4 });
        expect(track.status).toBe("ready");
        expect(track.duration).toBe(4);
    });

    test("immutable revisions and repeated playlist slots survive metadata and timing edits", async () => {
        const lib = await library();
        const track = await readyTrack(lib);
        const playlist = await lib.savePlaylist({ name: "Repeat set",
            slots: [{ id: "a", trackId: track.id }, { id: "b", trackId: track.id }] });
        const pinned = await lib.pinPlaylist(playlist.id);
        await lib.renameTrack(track.id, "Renamed", "New artist");
        const changed = await lib.manualTiming(track.id, 90, 0.1);
        expect(changed.chartId).not.toBe(track.chartId);
        expect(pinned.map(song => song.slotId)).toEqual(["a", "b"]);
        expect(pinned[0]!.title).toBe("pulse");
        expect(pinned[0]!.chartId).toBe(track.chartId!);
        const loaded = await lib.loadRevision(pinned[0]!.chartId);
        expect(loaded.manifest.bpm).toBe(120);
        expect(loaded.manifest.firstBeatOffset).toBe(0);
        expect(await lib.listCharts()).toHaveLength(2);
        expect((await lib.pinPlaylist(playlist.id))[0]!.chartId).toBe(changed.chartId!);
        loaded.dispose();
    });

    test("track deletion is atomic, requires explicit playlist removal, and honors active-run pins", async () => {
        const lib = await library(), track = await readyTrack(lib);
        const playlist = await lib.savePlaylist({ name: "Protected", slots: [{ id: "slot", trackId: track.id }] });
        await expect(lib.deleteTrack(track.id)).rejects.toThrow("Confirm removing");
        expect(await lib.listCharts()).toHaveLength(1);
        await withTransaction(lib.database!, ["runPins"], "readwrite", tx =>
            requestResult(tx.objectStore("runPins").put({ id: "active-run", trackIds: [track.id], chartIds: [track.chartId] })));
        await expect(lib.deleteTrack(track.id, { removePlaylistEntries: true })).rejects.toThrow("active run");
        expect((await lib.listPlaylists())[0]!.slots).toHaveLength(1);
        await withTransaction(lib.database!, ["runPins"], "readwrite", tx =>
            requestResult(tx.objectStore("runPins").delete("active-run")));
        await lib.deleteTrack(track.id, { removePlaylistEntries: true });
        expect(await lib.listTracks()).toHaveLength(0);
        expect(await lib.listCharts()).toHaveLength(0);
        expect(await readAll(lib.database!, "audio")).toHaveLength(0);
        expect((await lib.listPlaylists()).find(p => p.id === playlist.id)!.slots).toHaveLength(0);
    });

    test("suspending waits for unabortable decode, skips GPU inference, and later restarts one job", async () => {
        let releaseDecode!: (value: AudioBuffer) => void, decodes = 0, inferences = 0;
        const lib = await library({ getDecoder: () => ({ decodeAudioData: async () => {
            decodes++;
            if (decodes === 1) return new Promise(resolve => { releaseDecode = resolve; });
            return audio();
        } }), analyze: async () => { inferences++; return analysis(); } });
        await lib.importFiles([file()]);
        await lib.setGameplayActive(false);
        await eventually(() => !!releaseDecode);
        let suspended = false;
        const pending = lib.setGameplayActive(true).then(() => { suspended = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(suspended).toBe(false);
        expect(inferences).toBe(0);
        releaseDecode(audio());
        await pending;
        expect(lib.snapshot.tracks[0]!.status).toBe("interrupted");
        expect(inferences).toBe(0);
        await lib.setGameplayActive(false);
        await eventually(() => lib.snapshot.tracks[0]?.status === "ready");
        expect(inferences).toBe(1);
    });

    test("two library instances share one analysis owner and never infer concurrently", async () => {
        let current = 0, maximum = 0, analyzed = 0;
        const db = await database();
        const analyze: LibraryOptions["analyze"] = async () => {
            current++; maximum = Math.max(maximum, current); analyzed++;
            await new Promise(resolve => setTimeout(resolve, 5));
            current--;
            return analysis();
        };
        const a = await library({ database: db, analyze }), b = await library({ database: db, analyze });
        await a.importFiles([file(), file([4, 5, 6])]);
        await Promise.all([a.setGameplayActive(false), b.setGameplayActive(false)]);
        await eventually(() => a.snapshot.tracks.every(track => track.status === "ready") && analyzed === 2);
        expect(maximum).toBe(1);
        expect(await readAll(db, "charts")).toHaveLength(2);
    });

    test("queue aborts active GPU work and keeps originals available for retry", async () => {
        let started = false;
        const lib = await library({ analyze: (_buffer, options) => new Promise((_resolve, reject) => {
            started = true;
            options!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        }) });
        await lib.importFiles([file()]);
        await lib.setGameplayActive(false);
        await eventually(() => started);
        await lib.setGameplayActive(true);
        expect(lib.snapshot.busy).toBe(false);
        expect(lib.snapshot.tracks[0]!.status).toBe("interrupted");
        expect(lib.snapshot.tracks[0]!.audioAvailable).toBe(true);
    });

    test("gameplay in another tab cancels analysis before returning, then releases the queue", async () => {
        const db = await database();
        let calls = 0, started = false, cancelled = false;
        const a = await library({ database: db, analyze: (_buffer, options) => {
            calls++;
            if (calls > 1) return Promise.resolve(analysis());
            started = true;
            return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => {
                cancelled = true;
                reject(new DOMException("Cancelled", "AbortError"));
            }, { once: true }));
        } });
        const b = await library({ database: db });
        await b.setGameplayActive(false);
        await a.importFiles([file()]);
        await a.setGameplayActive(false);
        await eventually(() => started);
        await b.setGameplayActive(true);
        expect(cancelled).toBe(true);
        expect(a.snapshot.busy).toBe(false);
        expect(a.snapshot.tracks[0]!.status).toBe("interrupted");
        expect(calls).toBe(1);
        await b.setGameplayActive(false);
        await a.setGameplayActive(false);
        await eventually(() => a.snapshot.tracks[0]?.status === "ready" || b.snapshot.tracks[0]?.status === "ready");
        expect(await readAll(db, "charts")).toHaveLength(1);
    });

    test("unavailable IndexedDB is explicit and does not block Quick Play suspension", async () => {
        const lib = new MusicLibrary({ database: Promise.reject(new Error("Storage denied")),
            getDecoder: () => { throw new Error("No decoder needed"); }, broadcast: false });
        cleanups.push(() => lib.dispose());
        await lib.initialize();
        expect(lib.snapshot.available).toBe(false);
        expect(lib.snapshot.error).toContain("Storage denied");
        await lib.setGameplayActive(true);
        await lib.setGameplayActive(false);
        await expect(lib.importFiles([file()])).rejects.toThrow("Storage denied");
    });

    test("manual preparation and playable loading share one decoder slot", async () => {
        let release!: (value: AudioBuffer) => void, decodes = 0, active = 0, peak = 0;
        const lib = await library({ getDecoder: () => ({ decodeAudioData: async () => {
            decodes++; active++; peak = Math.max(peak, active);
            if (decodes === 1) {
                const buffer = await new Promise<AudioBuffer>(resolve => { release = resolve; });
                active--;
                return buffer;
            }
            active--;
            return audio();
        } }) });
        const original = await lib.persistOriginal(file());
        const playable = await readyTrack(lib, file([7, 8, 9], "next.wav"));
        const manual = lib.manualTiming(original.id, 130);
        await eventually(() => !!release);
        const loading = lib.loadRevision(playable.chartId!);
        let prepared = false;
        const prepareGameplay = lib.setGameplayActive(true).then(() => { prepared = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(decodes).toBe(1);
        expect(prepared).toBe(false);
        release(audio());
        await manual;
        const loaded = await loading;
        await prepareGameplay;
        expect(peak).toBe(1);
        expect(decodes).toBe(2);
        loaded.dispose();
    });
});

describe("recovery and transaction guarantees", () => {
    test("transaction failure rolls back writes across stores", async () => {
        const db = await database();
        await expect(withTransaction(db, ["meta", "playlists"], "readwrite", async tx => {
            await requestResult(tx.objectStore("meta").add({ id: "checkpoint", value: "new" }));
            await requestResult(tx.objectStore("playlists").add({ id: "temporary" }));
            await requestResult(tx.objectStore("meta").add({ id: "checkpoint", value: "duplicate" }));
        })).rejects.toThrow();
        expect(await readRecord(db, "meta", "checkpoint")).toBeUndefined();
        expect(await readAll(db, "playlists")).toEqual([]);
    });

    test("quota rejection reports import failure and never advertises an unsaved original", async () => {
        const lib = await library();
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "audio") throw new DOMException("Storage quota exceeded", "QuotaExceededError");
            return put.apply(this, args);
        };
        try {
            const result = await lib.importFiles([file()]);
            expect(result[0]!.error).toContain("quota");
            expect(result[0]!.track).toBeUndefined();
            expect(lib.snapshot.tracks).toEqual([]);
            expect(await readAll(lib.database!, "audio")).toEqual([]);
        } finally { IDBObjectStore.prototype.put = put; }
    });

    test("recovery excludes audio, restores typed features and requires exact-hash relinking", async () => {
        const source = await library(), original = file();
        const analyzed = analysis();
        analyzed.energy = {
            version: 1, sampleRate: 20, duration: 4, loudness: Array(80).fill(0.5), bass: Array(80).fill(0.2),
            features: { version: 1, bands: 16, frames: new Uint8Array(80 * 21).fill(64),
                travel: Float32Array.from({ length: 80 }, (_, i) => i * 0.05) },
        };
        const track = await source.persistAnalyzed(original, analyzed);
        await source.savePlaylist({ name: "Recovery", slots: [{ id: "a", trackId: track.id }, { id: "b", trackId: track.id }] });
        const json = await source.exportRecovery();
        expect(JSON.parse(json).audioIncluded).toBe(false);
        expect(JSON.parse(json).audio).toBeUndefined();
        const target = await library();
        await target.importRecovery(json);
        expect(target.snapshot.tracks[0]!.status).toBe("missing");
        expect(await readAll(target.database!, "audio")).toEqual([]);
        await expect(target.pinPlaylist(target.snapshot.playlists[0]!.id)).rejects.toThrow("Relink");
        await expect(target.relink(track.id, file([8, 9]))).rejects.toThrow("different recording");
        await target.relink(track.id, file([1, 2, 3], "renamed.wav"));
        const pinned = await target.pinPlaylist(target.snapshot.playlists[0]!.id);
        expect(pinned).toHaveLength(2);
        const loaded = await target.loadRevision(track.chartId!);
        expect(loaded.energy!.features!.frames).toBeInstanceOf(Uint8Array);
        expect(loaded.energy!.features!.travel).toBeInstanceOf(Float32Array);
        expect(loaded.energy!.features!.frames[12]).toBe(64);
        loaded.dispose();
    });

    test("bad references and unsupported run rules reject recovery before any write", async () => {
        const source = await library(), track = await readyTrack(source);
        const playlist = await source.savePlaylist({ name: "Set", slots: [{ id: "slot", trackId: track.id }] });
        const songs = await source.pinPlaylist(playlist.id);
        const run = createRun({ id: "run-recovery", title: "Run", songs, seed: 123 });
        await withTransaction(source.database!, ["runs", "meta"], "readwrite", tx => {
            tx.objectStore("runs").put(run);
            tx.objectStore("meta").put({ id: "active-run", runId: run.id });
        });
        const json = await source.exportRecovery(), target = await library();
        const malformed = JSON.parse(json);
        malformed.runs[0].rulesVersion = 999;
        await expect(target.importRecovery(JSON.stringify(malformed))).rejects.toThrow("unsupported");
        expect(await target.listTracks()).toEqual([]);
        const wrongReference = JSON.parse(json);
        wrongReference.playlists[0].slots[0].trackId = "a".repeat(64);
        expect(() => parseRecovery(JSON.stringify(wrongReference))).toThrow("missing track");
        await target.importRecovery(json);
        expect((await readRecord<{ runId: string }>(target.database!, "meta", "active-run"))!.runId).toBe(run.id);
        expect((await readRecord<{ trackIds: string[] }>(target.database!, "runPins", "active-run"))!.trackIds).toEqual([track.id]);
    });

    test("restoring old active recovery never resurrects a terminal local run", async () => {
        const lib = await library(), track = await readyTrack(lib);
        const playlist = await lib.savePlaylist({ name: "Set", slots: [{ id: "slot", trackId: track.id }] });
        const run = createRun({ id: "run-ended", title: "Run", songs: await lib.pinPlaylist(playlist.id), seed: 42 });
        await withTransaction(lib.database!, ["runs", "meta"], "readwrite", tx => {
            tx.objectStore("runs").put(run); tx.objectStore("meta").put({ id: "active-run", runId: run.id });
        });
        const json = await lib.exportRecovery(), ended = abandonRun(run);
        await withTransaction(lib.database!, ["runs", "runResults", "meta"], "readwrite", tx => {
            tx.objectStore("runs").put(ended); tx.objectStore("runResults").put(ended);
            tx.objectStore("meta").delete("active-run");
        });
        await importRecovery(lib.database!, json);
        expect((await readRecord<{ status: string }>(lib.database!, "runs", run.id))!.status).toBe("abandoned");
        expect(await readRecord(lib.database!, "meta", "active-run")).toBeUndefined();
    });

    test("immutable chart conflict rolls back the entire recovery import", async () => {
        const source = await library(), track = await readyTrack(source);
        const json = await source.exportRecovery(), target = await library();
        const conflicting = await source.getChart(track.chartId!);
        conflicting.manifest = { ...conflicting.manifest, title: "Different immutable content" };
        await withTransaction(target.database!, ["charts"], "readwrite",
            tx => requestResult(tx.objectStore("charts").put(conflicting)));
        await expect(target.importRecovery(json)).rejects.toThrow("immutable");
        expect(await target.listTracks()).toEqual([]);
        expect((await readAll<ChartRevision>(target.database!, "charts"))[0]!.manifest.title).toBe("Different immutable content");
    });
});
