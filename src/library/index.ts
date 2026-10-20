import { analyzeAudio, type AnalysisOptions, type BeatAnalysis } from "../analysis";
import { createAnalyzedChart, CHART_VERSION } from "../analysis/chart";
import { validateEnergyCurve } from "../analysis/energy";
import { validateSections } from "../analysis/sections";
import { generateTimeline, validateTempo } from "../rhythm/timeline";
import { TrackLoader, validateManifest, type LoadedTrack } from "../tracks";
import { pinPlaylist, validatePlaylist, type Playlist, type PlaylistSlot, type PinnedSong } from "../playlists";
import {
    openLibraryDatabase, readAll, readRecord, requestResult, withTransaction, type ActiveRunPins,
} from "./database";
import { acquireGameplayOwnership, withAnalysisOwnership } from "./ownership";
import {
    textField, validateLibraryTrack, validateChartRevision,
    type AudioRecord, type ChartRevision, type LibraryTrack,
} from "./types";
import { exportRecovery, importRecovery } from "./recovery";

export type { LibraryTrack, LibraryTrackStatus, ChartRevision } from "./types";
export { openLibraryDatabase } from "./database";
export type { Playlist, PlaylistSlot, PinnedSong } from "../playlists";

type Decoder = Pick<AudioContext, "decodeAudioData">;
export interface StorageStatus {
    usage?: number;
    quota?: number;
    persisted: boolean;
    persistenceSupported: boolean;
}
export interface LibrarySnapshot {
    available: boolean;
    initialized: boolean;
    tracks: readonly LibraryTrack[];
    playlists: readonly Playlist[];
    busy: boolean;
    gameplayActive: boolean;
    progress?: { trackId: string; stage: string; completed: number; total: number };
    storage: StorageStatus;
    error?: string;
}
export interface ImportResult { fileName: string; track?: LibraryTrack; duplicate?: boolean; error?: string }
export interface LibraryOptions {
    getDecoder: () => Decoder;
    database?: Promise<IDBDatabase> | IDBDatabase;
    analyze?: (buffer: AudioBuffer, options?: AnalysisOptions) => Promise<BeatAnalysis>;
    /** Tests may disable cross-tab broadcasts without changing persistence behavior. */
    broadcast?: boolean;
}
export interface SavePlaylistInput { id?: string; name: string; slots: readonly PlaylistSlot[] }
export interface ManualTiming { bpm: number; offset?: number; duration?: number }
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = () => new DOMException("Audio work was suspended for gameplay.", "AbortError");

/** Durable data API; renderer/session state never enters the database. */
export class MusicLibrary {
    private db?: IDBDatabase;
    private opening?: Promise<void>;
    private readonly listeners = new Set<(snapshot: LibrarySnapshot) => void>();
    private channel?: BroadcastChannel;
    private queueTask?: Promise<void>;
    private queueAbort?: AbortController;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private analysisLoader?: TrackLoader;
    private playbackLoader?: TrackLoader;
    private disposed = false;
    private activeLoaded?: LoadedTrack;
    private refreshRevision = 0;
    private mutations = Promise.resolve();
    private foreground = 0;
    private gameplayHold?: Promise<() => Promise<void>>;
    private gameplayAbort?: AbortController;
    private readonly options: LibraryOptions;
    private current: LibrarySnapshot = {
        available: false, initialized: false, tracks: [], playlists: [], busy: false, gameplayActive: false,
        storage: { persisted: false, persistenceSupported: false },
    };
    constructor(options: LibraryOptions) { this.options = options; }

    get snapshot(): LibrarySnapshot { return this.current; }
    /** Shared database for RunStore; call after initialize. */
    get database(): IDBDatabase | undefined { return this.db; }
    subscribe(listener: (snapshot: LibrarySnapshot) => void): () => void {
        this.listeners.add(listener);
        listener(this.current);
        return () => this.listeners.delete(listener);
    }
    initialize(): Promise<void> {
        return this.opening ??= this.open();
    }
    private async open(): Promise<void> {
        try {
            this.db = await (this.options.database ?? openLibraryDatabase());
            if (this.disposed) return;
            this.patch({ available: true, initialized: true, error: undefined });
            if (this.options.broadcast !== false && typeof BroadcastChannel !== "undefined") {
                this.channel = new BroadcastChannel("beatshooter-library");
                this.channel.onmessage = () => {
                    void this.refresh().then(() => this.pump()).catch(error => this.fail(error));
                };
            }
            await this.refresh();
            await this.refreshStorage();
            // First-use persistence is a best effort, with its result visible to UI.
            const requested = await readRecord<{ id: string; value: boolean }>(this.db, "meta", "persistence-requested");
            if (!requested) {
                await this.requestPersistence();
                await withTransaction(this.db, ["meta"], "readwrite", tx =>
                    requestResult(tx.objectStore("meta").put({ id: "persistence-requested", value: true })));
            }
            this.pump();
        } catch (error) {
            this.patch({ available: false, initialized: true, error: errorText(error) });
        }
    }

    async listTracks(): Promise<LibraryTrack[]> { await this.ready(); return readAll(this.db!, "tracks"); }
    async listPlaylists(): Promise<Playlist[]> { await this.ready(); return readAll(this.db!, "playlists"); }
    async listCharts(): Promise<ChartRevision[]> { await this.ready(); return readAll(this.db!, "charts"); }
    async getChart(id: string): Promise<ChartRevision> {
        await this.ready();
        const chart = await readRecord<ChartRevision>(this.db!, "charts", id);
        if (!chart) throw new Error("This chart is missing. Restore a recovery file or analyze the track again.");
        return validateChartRevision(chart);
    }
    async pinPlaylist(playlist: Playlist | string): Promise<PinnedSong[]> {
        await this.ready();
        return withTransaction(this.db!, ["playlists", "tracks", "charts", "audio"], "readonly", async tx => {
            const record = typeof playlist === "string"
                ? await requestResult<Playlist | undefined>(tx.objectStore("playlists").get(playlist)) : playlist;
            if (!record) throw new Error("This playlist no longer exists.");
            const tracks = await requestResult<LibraryTrack[]>(tx.objectStore("tracks").getAll());
            const chartIds = new Set(tracks.filter(track => record.slots.some(slot => slot.trackId === track.id))
                .map(track => track.chartId).filter((id): id is string => !!id));
            const charts: ChartRevision[] = [];
            for (const id of chartIds) {
                const chart = await requestResult<ChartRevision | undefined>(tx.objectStore("charts").get(id));
                // Pinning needs timing identities, not all ten songs' feature
                // arrays. Retain only the chart metadata while reading records.
                if (chart) charts.push(validateChartRevision({ ...chart, energy: undefined }));
            }
            const songs = pinPlaylist(validatePlaylist(record), tracks.map(validateLibraryTrack), charts);
            for (const song of songs) {
                const audio = await requestResult<AudioRecord | undefined>(tx.objectStore("audio").get(song.audioHash));
                if (!audio?.blob) throw new Error(`Relink the original audio for ${song.title} before starting.`);
            }
            return songs;
        });
    }

    /** Stores each original independently, so one failed file cannot discard a batch. */
    async importFiles(files: readonly File[]): Promise<ImportResult[]> {
        await this.ready();
        const result: ImportResult[] = [];
        for (const file of files) {
            try {
                const imported = await this.storeOriginal(file);
                result.push({ fileName: file.name, ...imported });
            } catch (error) {
                result.push({ fileName: file.name, error: errorText(error) });
                this.fail(error);
            }
        }
        await this.changed();
        this.pump();
        return result;
    }

    /** Preserve a legacy Quick Play selection without launching duplicate analysis. */
    async persistOriginal(file: File): Promise<LibraryTrack> {
        await this.ready();
        return this.foregroundWork(async () => {
            const { track } = await this.storeOriginal(file, undefined, true);
            await this.changed();
            return track;
        });
    }

    /**
     * Persists timing already produced by Quick Play without running inference
     * again. If duration is already known from analysis, no decode is necessary.
     */
    async persistAnalyzed(file: File, analysis?: BeatAnalysis, timing?: ManualTiming): Promise<LibraryTrack> {
        await this.ready();
        if (!analysis && !timing) throw new Error("Provide analyzed beats or manual BPM and offset.");
        return this.serializeMutation(() => this.foregroundWork(async () => {
            const { track } = await this.storeOriginal(file, undefined, true);
            const duration = analysis?.duration ?? timing?.duration ?? (await this.loader().prepareLocal(file)).buffer.duration;
            const latest = await this.requireTrack(track.id);
            const revision = this.createChart(latest, duration, analysis, timing);
            if (!await this.commitChart(latest, revision)) throw new Error("Track timing changed in another tab. Try again.");
            await this.changed();
            return (await this.requireTrack(track.id));
        }));
    }

    async retryAnalysis(id: string): Promise<void> {
        await this.ready();
        await this.updateTrack(id, track => {
            if (!track.audioAvailable) throw new Error("Relink the original audio before retrying analysis.");
            return { ...track, status: "queued", error: undefined, jobRevision: track.jobRevision + 1 };
        });
        await this.changed();
        this.pump();
    }

    async manualTiming(id: string, bpm: number, offset = 0): Promise<LibraryTrack> {
        validateTempo(bpm, offset);
        await this.ready();
        return this.serializeMutation(() => this.foregroundWork(async () => {
            const track = await this.requireTrack(id);
            const audio = await this.requireAudio(id);
            const duration = track.duration ?? (await this.loader().prepareLocal(this.file(track, audio.blob))).buffer.duration;
            const revision = this.createChart(track, duration, undefined, { bpm, offset });
            if (!await this.commitChart(track, revision)) throw new Error("Track timing changed in another tab. Try again.");
            await this.changed();
            return this.requireTrack(id);
        }));
    }

    /** Await this before song loading; cancelled inference and decode finish first. */
    async setGameplayActive(active: boolean): Promise<void> {
        this.patch({ gameplayActive: active });
        if (active) {
            if (!this.gameplayHold) {
                const abort = this.gameplayAbort = new AbortController();
                const hold = this.gameplayHold = (async () => {
                    await this.initialize();
                    if (!this.db || !this.current.available || abort.signal.aborted) return async () => {};
                    return acquireGameplayOwnership(this.db, abort.signal);
                })();
                void hold.catch(() => {});
            }
            await this.suspendQueue();
            await this.mutations;
            try { await this.gameplayHold; }
            catch (error) {
                // Storage denial must not turn optional library persistence into
                // a prerequisite for ordinary Quick Play. This tab is already idle.
                if (!(error instanceof DOMException && error.name === "AbortError")) this.fail(error);
            }
        } else {
            this.gameplayAbort?.abort();
            const held = this.gameplayHold;
            this.gameplayHold = undefined;
            this.gameplayAbort = undefined;
            await held?.then(release => release(), () => {});
            this.pump();
        }
    }
    async whenIdle(): Promise<void> { await this.mutations; await this.queueTask; }

    async loadRevision(chartId: string): Promise<LoadedTrack> {
        await this.ready();
        return this.serializeMutation(() => this.foregroundWork(async () => {
            const revision = await this.getChart(chartId);
            const track = await this.requireTrack(revision.trackId);
            const audio = await this.requireAudio(revision.contentHash);
            this.activeLoaded?.dispose();
            this.activeLoaded = undefined;
            this.playbackLoader?.dispose();
            const loader = this.playbackLoader = new TrackLoader(this.options.getDecoder());
            const prepared = await loader.prepareLocal(this.file(track, audio.blob));
            if (prepared.contentHash !== revision.contentHash || Math.abs(prepared.buffer.duration - revision.manifest.duration) > 0.15) {
                loader.dispose();
                throw new Error("The stored audio does not match its pinned chart. Relink the original file.");
            }
            const url = URL.createObjectURL(audio.blob);
            let disposed = false;
            const loaded: LoadedTrack = {
                manifest: { ...revision.manifest, audioUrl: url }, buffer: prepared.buffer,
                energy: revision.energy, structure: revision.manifest.structure,
                dispose: () => {
                    if (disposed) return;
                    disposed = true;
                    URL.revokeObjectURL(url);
                    loader.dispose();
                    if (this.activeLoaded === loaded) this.activeLoaded = undefined;
                },
            };
            // The LoadedTrack alone retains this buffer; no extra queue/playback cache.
            loader.clearLocalCache();
            this.activeLoaded = loaded;
            return loaded;
        }));
    }

    async renameTrack(id: string, title: string, artist?: string): Promise<void> {
        title = textField(title, "track title");
        if (artist !== undefined) artist = textField(artist, "artist");
        await this.ready();
        await this.updateTrack(id, track => ({ ...track, title, artist: artist ?? track.artist }));
        await this.changed();
    }
    async affectedPlaylists(id: string): Promise<Playlist[]> {
        return (await this.listPlaylists()).filter(playlist => playlist.slots.some(slot => slot.trackId === id));
    }
    async deleteTrack(id: string, options: { removePlaylistEntries?: boolean } = {}): Promise<void> {
        await this.ready();
        await withTransaction(this.db!, ["tracks", "audio", "charts", "playlists", "runPins"], "readwrite", async tx => {
            const pins = await requestResult<ActiveRunPins | undefined>(tx.objectStore("runPins").get("active-run"));
            const charts = await requestResult<ChartRevision[]>(tx.objectStore("charts").getAll());
            const ownedCharts = charts.filter(chart => chart.trackId === id);
            if (pins?.trackIds.includes(id) || ownedCharts.some(chart => pins?.chartIds.includes(chart.id))) {
                throw new Error("This track is used by the active run. Finish or abandon that run before deleting it.");
            }
            const playlists = await requestResult<Playlist[]>(tx.objectStore("playlists").getAll());
            const affected = playlists.filter(playlist => playlist.slots.some(slot => slot.trackId === id));
            if (affected.length && !options.removePlaylistEntries) {
                throw new Error(`This track appears in ${affected.map(item => item.name).join(", ")}. Confirm removing those playlist entries.`);
            }
            for (const playlist of affected) tx.objectStore("playlists").put({
                ...playlist, slots: playlist.slots.filter(slot => slot.trackId !== id), updatedAt: Date.now(),
            });
            for (const chart of ownedCharts) tx.objectStore("charts").delete(chart.id);
            tx.objectStore("audio").delete(id);
            tx.objectStore("tracks").delete(id);
        });
        await this.changed();
    }
    async relink(id: string, file: File): Promise<LibraryTrack> {
        await this.ready();
        const track = await this.requireTrack(id);
        const hash = await this.hashFile(file);
        if (hash !== track.contentHash) throw new Error("This is a different recording. Choose the original file with the same content hash.");
        const result = await this.storeOriginal(file, hash);
        await this.changed();
        this.pump();
        return result.track;
    }

    async savePlaylist(input: SavePlaylistInput): Promise<Playlist> {
        await this.ready();
        const now = Date.now(), id = input.id ?? `playlist-${crypto.randomUUID()}`;
        const playlist = await withTransaction(this.db!, ["playlists", "tracks"], "readwrite", async tx => {
            const previous = await requestResult<Playlist | undefined>(tx.objectStore("playlists").get(id));
            const result = validatePlaylist({ schemaVersion: 1, id, name: input.name, slots: [...input.slots],
                createdAt: previous?.createdAt ?? now, updatedAt: now });
            for (const trackId of new Set(result.slots.map(slot => slot.trackId))) {
                if (!await requestResult(tx.objectStore("tracks").getKey(trackId))) {
                    throw new Error("A playlist track is missing from the library.");
                }
            }
            tx.objectStore("playlists").put(result);
            return result;
        });
        await this.changed();
        return playlist;
    }
    async deletePlaylist(id: string): Promise<void> {
        await this.ready();
        await withTransaction(this.db!, ["playlists"], "readwrite",
            tx => requestResult(tx.objectStore("playlists").delete(id)));
        await this.changed();
    }

    async refreshStorage(): Promise<StorageStatus> {
        const storage = globalThis.navigator?.storage;
        let estimate: StorageEstimate = {}, persisted = false;
        try {
            estimate = await storage?.estimate?.() ?? {};
            persisted = await storage?.persisted?.() ?? false;
        } catch { /* Browsing still works when estimates are denied. */ }
        const result = { usage: estimate.usage, quota: estimate.quota, persisted,
            persistenceSupported: typeof storage?.persist === "function" };
        this.patch({ storage: result });
        return result;
    }
    async requestPersistence(): Promise<StorageStatus> {
        try { await globalThis.navigator?.storage?.persist?.(); }
        catch { /* Denial is represented in the returned persisted flag. */ }
        return this.refreshStorage();
    }
    async exportRecovery(): Promise<string> { await this.ready(); return exportRecovery(this.db!); }
    async importRecovery(text: string): Promise<void> {
        await this.ready();
        await this.foregroundWork(async () => {
            await importRecovery(this.db!, text);
            await this.changed();
        });
    }
    dispose(): void {
        this.disposed = true;
        this.queueAbort?.abort();
        this.gameplayAbort?.abort();
        void this.gameplayHold?.then(release => release(), () => {}).catch(() => {});
        this.analysisLoader?.cancel();
        this.playbackLoader?.dispose();
        this.activeLoaded?.dispose();
        this.channel?.close();
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.listeners.clear();
        // The caller and RunStore may share this connection; do not close it here.
    }

    private async ready(): Promise<void> {
        await this.initialize();
        if (this.disposed) throw new Error("This music library has been closed.");
        if (!this.db || !this.current.available) throw new Error(this.current.error ?? "The music library is unavailable.");
    }
    private loader(): TrackLoader { return this.analysisLoader ??= new TrackLoader(this.options.getDecoder()); }
    private file(track: LibraryTrack, blob: Blob): File {
        return new File([blob], track.fileName, { type: track.mime, lastModified: track.lastModified });
    }
    private async hashFile(file: File): Promise<string> {
        if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("Choose a nonempty audio file no larger than 100 MiB.");
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    private async storeOriginal(file: File, knownHash?: string, deferAnalysis = false): Promise<{ track: LibraryTrack; duplicate: boolean }> {
        const id = knownHash ?? await this.hashFile(file), now = Date.now();
        return withTransaction(this.db!, ["audio", "tracks"], "readwrite", async tx => {
            const tracks = tx.objectStore("tracks");
            const existing = await requestResult<LibraryTrack | undefined>(tracks.get(id));
            const original = await requestResult<AudioRecord | undefined>(tx.objectStore("audio").get(id));
            if (existing && original?.blob && existing.audioAvailable && (!deferAnalysis || existing.chartId)) {
                return { track: existing, duplicate: true };
            }
            const track: LibraryTrack = existing ? {
                ...existing, audioAvailable: true, status: existing.chartId ? "ready" : deferAnalysis ? "needs-timing" : "queued",
                updatedAt: now, error: undefined, jobRevision: existing.jobRevision + (deferAnalysis ? 1 : 0),
            } : {
                schemaVersion: 1, id, contentHash: id,
                title: file.name.replace(/\.[^.]+$/, "").slice(0, 256) || "Untitled",
                artist: "Local music", fileName: file.name.slice(0, 1024), mime: file.type,
                size: file.size, lastModified: file.lastModified, createdAt: now, updatedAt: now,
                status: deferAnalysis ? "needs-timing" : "queued", audioAvailable: true, jobRevision: 0,
            };
            tx.objectStore("audio").put({ id, blob: file.slice(0, file.size, file.type) } satisfies AudioRecord);
            tracks.put(validateLibraryTrack(track));
            return { track, duplicate: !!existing };
        });
    }
    private async requireTrack(id: string): Promise<LibraryTrack> {
        const track = await readRecord<LibraryTrack>(this.db!, "tracks", id);
        if (!track) throw new Error("This track is no longer in the library.");
        return validateLibraryTrack(track);
    }
    private async requireAudio(id: string): Promise<AudioRecord> {
        const audio = await readRecord<AudioRecord>(this.db!, "audio", id);
        if (!audio?.blob) throw new Error("The original audio is missing. Relink the same file from your device.");
        return audio;
    }
    private async updateTrack(id: string, update: (track: LibraryTrack) => LibraryTrack): Promise<void> {
        await withTransaction(this.db!, ["tracks"], "readwrite", async tx => {
            const store = tx.objectStore("tracks"), track = await requestResult<LibraryTrack | undefined>(store.get(id));
            if (!track) throw new Error("This track is no longer in the library.");
            store.put(validateLibraryTrack({ ...update(track), updatedAt: Date.now() }));
        });
    }
    private createChart(track: LibraryTrack, duration: number, analysis?: BeatAnalysis, timing?: ManualTiming): ChartRevision {
        const chart = analysis ? createAnalyzedChart(analysis) : undefined;
        if (!chart && !timing) throw new Error("This track needs analyzed beats or manual timing.");
        const id = `chart-${crypto.randomUUID()}`;
        const structure = validateSections(analysis?.structure, duration);
        const manifest = validateManifest({
            schemaVersion: 1, id, title: track.title, artist: track.artist, audioUrl: `library:${track.id}`,
            duration, bpm: chart?.bpm ?? timing!.bpm,
            firstBeatOffset: chart?.firstBeatOffset ?? timing?.offset ?? 0, beatsPerBar: chart?.beatsPerBar ?? 4,
            beats: chart?.beats ?? generateTimeline(duration, timing!.bpm, timing?.offset ?? 0),
            ...(structure ? { structure } : {}),
            source: `User-selected file: ${track.fileName}`,
            license: "User-provided; never uploaded or redistributed",
        });
        const energy = validateEnergyCurve(analysis?.energy, duration);
        return validateChartRevision({
            schemaVersion: 1, id, trackId: track.id, contentHash: track.contentHash, createdAt: Date.now(),
            timing: analysis ? "analyzed" : "manual", chartVersion: CHART_VERSION,
            ...(analysis ? { analyzerVersion: analysis.analyzerVersion } : {}), manifest,
            ...(energy ? { energy } : {}),
            ...(analysis?.sectionWarning ? { warning: analysis.sectionWarning } : {}),
        });
    }
    private async commitChart(track: LibraryTrack, revision: ChartRevision): Promise<boolean> {
        return withTransaction(this.db!, ["tracks", "charts"], "readwrite", async tx => {
            const store = tx.objectStore("tracks"), current = await requestResult<LibraryTrack | undefined>(store.get(track.id));
            if (!current || current.jobRevision !== track.jobRevision) return false;
            tx.objectStore("charts").add(revision);
            store.put({ ...current, chartId: revision.id, duration: revision.manifest.duration,
                bpm: revision.manifest.bpm, firstBeatOffset: revision.manifest.firstBeatOffset, timing: revision.timing,
                status: "ready", error: revision.warning, updatedAt: Date.now(), jobRevision: current.jobRevision + 1 });
            return true;
        });
    }
    private async serializeMutation<T>(work: () => Promise<T>): Promise<T> {
        const result = this.mutations.then(work);
        this.mutations = result.then(() => {}, () => {});
        return result;
    }
    private async foregroundWork<T>(work: () => Promise<T>): Promise<T> {
        this.foreground++;
        try {
            await this.suspendQueue();
            if (this.disposed) throw new Error("This music library has been closed.");
            return await work();
        } finally {
            this.foreground--;
            this.analysisLoader?.clearLocalCache();
            this.pump();
        }
    }
    private async suspendQueue(): Promise<void> {
        this.queueAbort?.abort();
        // Manual preparation shares the loader but is serialized separately;
        // gameplay must wait for it, not accidentally cancel a valid edit.
        if (this.queueTask) this.analysisLoader?.cancel();
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        await this.queueTask;
    }
    private pump(): void {
        if (this.disposed || !this.db || !this.current.available || this.current.gameplayActive || this.queueTask || this.foreground) return;
        const abort = this.queueAbort = new AbortController();
        this.queueTask = this.runQueue(abort).catch(error => this.fail(error)).finally(() => {
            this.queueTask = undefined;
            this.queueAbort = undefined;
            this.analysisLoader?.clearLocalCache();
            this.patch({ busy: false, progress: undefined });
            if (!abort.signal.aborted && this.current.tracks.some(track => track.audioAvailable &&
                ["queued", "interrupted", "analyzing", "importing"].includes(track.status)) && !this.retryTimer) {
                this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 0);
            }
        });
    }
    private async runQueue(abort: AbortController): Promise<void> {
        const acquired = await withAnalysisOwnership(this.db!, abort.signal, async signal => {
            while (!signal.aborted && !this.current.gameplayActive && !this.disposed) {
                const tracks = await readAll<LibraryTrack>(this.db!, "tracks");
                const track = tracks.sort((a, b) => a.createdAt - b.createdAt)
                    .find(item => item.audioAvailable && ["queued", "interrupted", "analyzing", "importing"].includes(item.status));
                if (!track) return;
                this.patch({ busy: true });
                await this.processTrack(track, signal);
            }
        });
        if (!acquired && !abort.signal.aborted && !this.current.gameplayActive && !this.disposed) {
            this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 2000);
        }
    }
    private async processTrack(track: LibraryTrack, signal: AbortSignal): Promise<void> {
        let duration = track.duration;
        try {
            await this.updateTrack(track.id, current => current.jobRevision === track.jobRevision
                ? { ...current, status: "analyzing", error: undefined } : current);
            await this.changed();
            if (signal.aborted) throw aborted();
            const audio = await this.requireAudio(track.id);
            const prepared = await this.loader().prepareLocal(this.file(track, audio.blob));
            if (signal.aborted) throw aborted();
            duration = prepared.buffer.duration;
            const analysis = await (this.options.analyze ?? analyzeAudio)(prepared.buffer, {
                signal, onProgress: progress => this.patch({ progress: { ...progress, trackId: track.id } }),
            });
            if (signal.aborted) throw aborted();
            if (Math.abs(analysis.duration - duration) > 0.05) throw new Error("The analysis duration does not match this audio.");
            const revision = this.createChart(track, duration, analysis);
            await this.commitChart(track, revision);
        } catch (error) {
            const interrupted = signal.aborted || (error instanceof DOMException && error.name === "AbortError");
            await withTransaction(this.db!, ["tracks"], "readwrite", async tx => {
                const store = tx.objectStore("tracks"), current = await requestResult<LibraryTrack | undefined>(store.get(track.id));
                if (!current || current.jobRevision !== track.jobRevision) return;
                store.put({ ...current, ...(duration ? { duration } : {}),
                    status: interrupted ? "interrupted" : duration ? "needs-timing" : "failed",
                    error: interrupted ? "Analysis paused. It will resume when gameplay ends." : errorText(error).slice(0, 4096),
                    updatedAt: Date.now() });
            });
        } finally {
            this.analysisLoader?.clearLocalCache();
            await this.changed();
        }
    }
    private async changed(): Promise<void> {
        await this.refresh();
        await this.refreshStorage();
        this.channel?.postMessage("changed");
    }
    async refresh(): Promise<void> {
        if (!this.db || this.disposed) return;
        const revision = ++this.refreshRevision;
        const [tracks, playlists] = await Promise.all([readAll<LibraryTrack>(this.db, "tracks"), readAll<Playlist>(this.db, "playlists")]);
        if (revision !== this.refreshRevision || this.disposed) return;
        this.patch({ tracks: tracks.map(validateLibraryTrack).sort((a, b) => b.createdAt - a.createdAt),
            playlists: playlists.map(validatePlaylist).sort((a, b) => b.updatedAt - a.updatedAt) });
    }
    private fail(error: unknown): void { this.patch({ error: errorText(error) }); }
    private patch(patch: Partial<LibrarySnapshot>): void {
        this.current = { ...this.current, ...patch };
        for (const listener of this.listeners) listener(this.current);
    }
}
