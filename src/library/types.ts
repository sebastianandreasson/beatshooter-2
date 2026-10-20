import type { EnergyCurve } from "../analysis/types";
import { validateEnergyCurve } from "../analysis/energy";
import { validateManifest, type TrackManifest } from "../tracks";

export type LibraryTrackStatus = "importing" | "queued" | "analyzing" | "ready" | "needs-timing" |
    "interrupted" | "failed" | "missing";

export interface LibraryTrack {
    schemaVersion: 1;
    /** SHA-256 of original bytes; identity survives metadata edits and relinking. */
    id: string;
    contentHash: string;
    title: string;
    artist: string;
    fileName: string;
    mime: string;
    size: number;
    lastModified: number;
    createdAt: number;
    updatedAt: number;
    status: LibraryTrackStatus;
    audioAvailable: boolean;
    duration?: number;
    chartId?: string;
    bpm?: number;
    firstBeatOffset?: number;
    timing?: "analyzed" | "manual";
    error?: string;
    /** Invalidates stale queue results after manual timing, retry, or deletion. */
    jobRevision: number;
}

export interface AudioRecord {
    id: string;
    blob: Blob;
}

export interface ChartRevision {
    schemaVersion: 1;
    id: string;
    trackId: string;
    contentHash: string;
    createdAt: number;
    timing: "analyzed" | "manual";
    analyzerVersion?: string;
    chartVersion: string;
    manifest: TrackManifest;
    energy?: EnergyCurve;
    warning?: string;
}

export function validHash(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function safeId(value: unknown): value is string {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
        value !== "constructor" && value !== "prototype";
}
export function textField(value: unknown, name: string, limit = 256): string {
    if (typeof value !== "string" || !value.trim() || value.length > limit) {
        throw new Error(`A valid ${name} is required (at most ${limit} characters).`);
    }
    return value.trim();
}
function timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateLibraryTrack(value: unknown): LibraryTrack {
    if (!value || typeof value !== "object") throw new Error("Invalid library track.");
    const t = value as LibraryTrack;
    if (t.schemaVersion !== 1 || !validHash(t.id) || t.contentHash !== t.id ||
        !Number.isSafeInteger(t.size) || t.size <= 0 || t.size > 100 * 1024 * 1024 ||
        !timestamp(t.lastModified) || !timestamp(t.createdAt) || !timestamp(t.updatedAt) ||
        !Number.isSafeInteger(t.jobRevision) || t.jobRevision < 0 ||
        typeof t.audioAvailable !== "boolean" || typeof t.mime !== "string" || t.mime.length > 256 ||
        !["importing", "queued", "analyzing", "ready", "needs-timing", "interrupted", "failed", "missing"].includes(t.status) ||
        (t.chartId !== undefined && !safeId(t.chartId)) ||
        (t.duration !== undefined && (!Number.isFinite(t.duration) || t.duration <= 0 || t.duration > 21_600)) ||
        (t.bpm !== undefined && (!Number.isFinite(t.bpm) || t.bpm < 20 || t.bpm > 300)) ||
        (t.firstBeatOffset !== undefined && (!Number.isFinite(t.firstBeatOffset) || t.firstBeatOffset < 0 ||
            (t.duration !== undefined && t.firstBeatOffset >= t.duration))) ||
        (t.timing !== undefined && !["analyzed", "manual"].includes(t.timing)) ||
        (t.error !== undefined && (typeof t.error !== "string" || t.error.length > 4096))) {
        throw new Error("The library track metadata is invalid or unsupported.");
    }
    return {
        schemaVersion: 1, id: t.id, contentHash: t.id,
        title: textField(t.title, "track title"), artist: textField(t.artist, "artist"),
        fileName: textField(t.fileName, "filename", 1024), mime: t.mime, size: t.size,
        lastModified: t.lastModified, createdAt: t.createdAt, updatedAt: t.updatedAt,
        status: t.status, audioAvailable: t.audioAvailable, jobRevision: t.jobRevision,
        ...(t.chartId ? { chartId: t.chartId } : {}), ...(t.duration !== undefined ? { duration: t.duration } : {}),
        ...(t.bpm !== undefined ? { bpm: t.bpm } : {}),
        ...(t.firstBeatOffset !== undefined ? { firstBeatOffset: t.firstBeatOffset } : {}),
        ...(t.timing ? { timing: t.timing } : {}),
        ...(t.error ? { error: t.error } : {}),
    };
}

export function validateChartRevision(value: unknown): ChartRevision {
    if (!value || typeof value !== "object") throw new Error("Invalid chart revision.");
    const c = value as ChartRevision;
    if (c.schemaVersion !== 1 || !safeId(c.id) || !validHash(c.trackId) || c.trackId !== c.contentHash ||
        !timestamp(c.createdAt) || !["analyzed", "manual"].includes(c.timing) ||
        typeof c.chartVersion !== "string" || !c.chartVersion || c.chartVersion.length > 128 ||
        (c.analyzerVersion !== undefined && (typeof c.analyzerVersion !== "string" || c.analyzerVersion.length > 256)) ||
        (c.warning !== undefined && (typeof c.warning !== "string" || c.warning.length > 4096))) {
        throw new Error("The chart revision is invalid or unsupported.");
    }
    const manifest = validateManifest(c.manifest);
    if (manifest.id !== c.id || manifest.audioUrl !== `library:${c.trackId}`) {
        throw new Error("The chart does not reference its original audio.");
    }
    const energy = validateEnergyCurve(c.energy, manifest.duration);
    if (c.energy !== undefined && !energy) throw new Error("The chart's cached audio features are invalid.");
    return {
        schemaVersion: 1, id: c.id, trackId: c.trackId, contentHash: c.contentHash, createdAt: c.createdAt,
        timing: c.timing, chartVersion: c.chartVersion, manifest,
        ...(c.analyzerVersion ? { analyzerVersion: c.analyzerVersion } : {}),
        ...(energy ? { energy } : {}), ...(c.warning ? { warning: c.warning } : {}),
    };
}
