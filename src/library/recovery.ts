import { validateEnergyCurve } from "../analysis/energy";
import { validateFeatures } from "../analysis/features";
import { validatePlaylist, type Playlist } from "../playlists";
import { isTerminalRun, validateRunRecord, type RunRecord } from "../run/model";
import { requestResult, withTransaction, type ActiveRunPins } from "./database";
import {
    validateChartRevision, validateLibraryTrack, type AudioRecord, type ChartRevision, type LibraryTrack,
} from "./types";

export interface RecoveryData {
    format: "beatshooter-recovery";
    version: 1;
    audioIncluded: false;
    exportedAt: number;
    tracks: LibraryTrack[];
    charts: ChartRevision[];
    playlists: Playlist[];
    runs: RunRecord[];
    results: RunRecord[];
    activeRunId?: string;
}
const RECOVERY_STORES = ["tracks", "charts", "playlists", "runs", "runResults", "meta"] as const;

/** JSON keeps portable compact features rather than typed-array object keys. */
function portableChart(chart: ChartRevision): unknown {
    const features = chart.energy?.features;
    return features ? { ...chart, energy: { ...chart.energy, features: { ...features,
        frames: Array.from(features.frames), travel: Array.from(features.travel),
    } } } : chart;
}

function restoreChart(value: unknown): ChartRevision {
    if (!value || typeof value !== "object") throw new Error("Invalid recovery chart.");
    const chart = value as ChartRevision;
    const energy = chart.energy;
    if (energy?.features) {
        const raw = energy.features as unknown as { version: unknown; bands: unknown; frames: unknown; travel: unknown };
        const count = Math.ceil(energy.duration * 20);
        if (!Number.isFinite(count) || count < 1 || count > 432_000 ||
            !Array.isArray(raw.frames) || raw.frames.length !== count * 21 ||
            !raw.frames.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ||
            !Array.isArray(raw.travel) || raw.travel.length !== count ||
            !raw.travel.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
            throw new Error("Invalid cached visual features in recovery file.");
        }
        const features = validateFeatures({
            version: raw.version, bands: raw.bands,
            frames: new Uint8Array(raw.frames), travel: new Float32Array(raw.travel),
        }, count);
        if (!features) throw new Error("Invalid cached visual features in recovery file.");
        const restored = validateEnergyCurve({ ...energy, features }, chart.manifest?.duration);
        if (!restored) throw new Error("Invalid audio energy in recovery file.");
        return validateChartRevision({ ...chart, energy: restored });
    }
    return validateChartRevision(chart);
}

function records<T>(value: unknown, max: number, validate: (record: unknown) => T & { id: string }): T[] {
    if (!Array.isArray(value) || value.length > max) throw new Error("Recovery file has too many records or invalid collections.");
    const seen = new Set<string>();
    return value.map(item => {
        const record = validate(item);
        if (seen.has(record.id)) throw new Error("Recovery file contains duplicate record identities.");
        seen.add(record.id);
        return record;
    });
}

export function parseRecovery(text: string): RecoveryData {
    if (text.length > 128 * 1024 * 1024) throw new Error("This recovery file is too large.");
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error("This is not a valid recovery JSON file."); }
    if (!raw || raw.format !== "beatshooter-recovery" || raw.version !== 1 || raw.audioIncluded !== false ||
        typeof raw.exportedAt !== "number" || !Number.isFinite(raw.exportedAt) || raw.exportedAt < 0) {
        throw new Error("This recovery format is not supported. Keep the original file.");
    }
    const tracks = records(raw.tracks, 2000, validateLibraryTrack);
    const charts = records(raw.charts, 10_000, restoreChart);
    const playlists = records(raw.playlists, 1000, validatePlaylist);
    const runs = records(raw.runs, 2000, validateRunRecord);
    const results = records(raw.results, 2000, validateRunRecord);
    const byTrack = new Map(tracks.map(track => [track.id, track]));
    const byChart = new Map(charts.map(chart => [chart.id, chart]));
    const byRun = new Map(runs.map(run => [run.id, run]));
    for (const chart of charts) if (!byTrack.has(chart.trackId)) throw new Error("A recovery chart has no original track metadata.");
    for (const track of tracks) {
        if (track.chartId) {
            const chart = byChart.get(track.chartId);
            if (!chart || chart.trackId !== track.id || chart.manifest.duration !== track.duration) {
                throw new Error("A recovery track references a missing or mismatched chart.");
            }
        }
    }
    for (const playlist of playlists) for (const slot of playlist.slots) {
        if (!byTrack.has(slot.trackId)) throw new Error("A recovery playlist references a missing track.");
    }
    // Historical terminal summaries survive ordinary library deletions. Active
    // runs must retain every pinned original and exact chart revision.
    for (const run of runs) {
        if (isTerminalRun(run)) continue;
        for (const song of run.songs) {
            const chart = byChart.get(song.chartId);
            if (!byTrack.has(song.trackId) || !chart || chart.trackId !== song.trackId ||
                chart.manifest.duration !== song.duration || chart.timing !== song.timing) {
                throw new Error("The active recovery run references missing or mismatched songs.");
            }
        }
        if (raw.activeRunId !== run.id) throw new Error("A recovery file cannot contain multiple active runs.");
    }
    for (const result of results) {
        const run = byRun.get(result.id);
        if (!isTerminalRun(result) || !run || JSON.stringify(run) !== JSON.stringify(result)) {
            throw new Error("A recovery result does not match its terminal run.");
        }
    }
    if (raw.activeRunId !== undefined && (typeof raw.activeRunId !== "string" ||
        !byRun.has(raw.activeRunId) || isTerminalRun(byRun.get(raw.activeRunId)!))) {
        throw new Error("The recovery active-run reference is invalid.");
    }
    return {
        format: "beatshooter-recovery", version: 1, audioIncluded: false, exportedAt: raw.exportedAt,
        tracks, charts, playlists, runs, results, ...(typeof raw.activeRunId === "string" ? { activeRunId: raw.activeRunId } : {}),
    };
}

export async function exportRecovery(db: IDBDatabase): Promise<string> {
    const data = await withTransaction(db, RECOVERY_STORES, "readonly", async tx => {
        const tracks = await requestResult<LibraryTrack[]>(tx.objectStore("tracks").getAll());
        const charts = await requestResult<ChartRevision[]>(tx.objectStore("charts").getAll());
        const playlists = await requestResult<Playlist[]>(tx.objectStore("playlists").getAll());
        const runs = await requestResult<RunRecord[]>(tx.objectStore("runs").getAll());
        const results = await requestResult<RunRecord[]>(tx.objectStore("runResults").getAll());
        const active = await requestResult<{ id: string; runId: string } | undefined>(tx.objectStore("meta").get("active-run"));
        return { format: "beatshooter-recovery", version: 1, audioIncluded: false, exportedAt: Date.now(),
            tracks, charts: charts.map(portableChart), playlists, runs, results,
            ...(active?.runId ? { activeRunId: active.runId } : {}) };
    });
    const json = JSON.stringify(data);
    parseRecovery(json); // Never label a corrupt or incompatible checkpoint a valid recovery export.
    return json;
}

/** Validate everything before opening the single atomic import transaction. */
export async function importRecovery(db: IDBDatabase, text: string): Promise<void> {
    const data = parseRecovery(text);
    await withTransaction(db, [...RECOVERY_STORES, "audio", "runPins", "leases"], "readwrite", async tx => {
        const active = await requestResult<{ id: string; runId: string } | undefined>(tx.objectStore("meta").get("active-run"));
        if (active?.runId && data.activeRunId && active.runId !== data.activeRunId) {
            throw new Error("An active local run already exists. Finish or abandon it before restoring another run.");
        }
        for (const track of data.tracks) {
            const existing = await requestResult<LibraryTrack | undefined>(tx.objectStore("tracks").get(track.id));
            if (existing) continue;
            const audio = await requestResult<AudioRecord | undefined>(tx.objectStore("audio").get(track.id));
            tx.objectStore("tracks").add({
                ...track, audioAvailable: !!audio?.blob, status: audio?.blob ? track.chartId ? "ready" : "queued" : "missing",
                error: audio?.blob ? undefined : "Audio is not included in recovery files. Relink the original file.",
            } satisfies LibraryTrack);
        }
        for (const chart of data.charts) {
            const existing = await requestResult<ChartRevision | undefined>(tx.objectStore("charts").get(chart.id));
            if (existing && JSON.stringify(portableChart(existing)) !== JSON.stringify(portableChart(chart))) {
                throw new Error("A recovery chart conflicts with an immutable local revision.");
            }
            if (!existing) tx.objectStore("charts").add(chart);
        }
        for (const playlist of data.playlists) {
            if (!await requestResult(tx.objectStore("playlists").getKey(playlist.id))) tx.objectStore("playlists").add(playlist);
        }
        let recoveredActive: RunRecord | undefined;
        for (const run of data.runs) {
            const existing = await requestResult<RunRecord | undefined>(tx.objectStore("runs").get(run.id));
            if (existing) continue; // Never roll back revisions or resurrect terminal tombstones.
            tx.objectStore("runs").add(run);
            if (run.id === data.activeRunId) recoveredActive = run;
        }
        for (const result of data.results) {
            const run = await requestResult<RunRecord | undefined>(tx.objectStore("runs").get(result.id));
            if (run && isTerminalRun(run) && !await requestResult(tx.objectStore("runResults").getKey(result.id))) {
                tx.objectStore("runResults").add(run);
            }
        }
        if (!active?.runId && recoveredActive) {
            const lease = await requestResult<{ id: string; expiresAt: number } | undefined>(
                tx.objectStore("leases").get("active-run-owner"),
            );
            if (lease && lease.expiresAt > Date.now()) throw new Error("Another tab owns this run. Close it before restoring recovery.");
            tx.objectStore("meta").put({ id: "active-run", runId: recoveredActive.id });
            tx.objectStore("runPins").put({
                id: "active-run", trackIds: [...new Set(recoveredActive.songs.map(song => song.trackId))],
                chartIds: [...new Set(recoveredActive.songs.map(song => song.chartId))],
            } satisfies ActiveRunPins);
        }
    });
}
