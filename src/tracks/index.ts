import demoManifest from "../../public/tracks/neon-circuit.json";
import { generateTimeline, type Beat, validateTempo, validateTimeline } from "../rhythm/timeline";
import { createAnalyzedChart } from "../analysis/chart";
import type { BeatAnalysis } from "../analysis/types";

export interface TrackManifest {
    schemaVersion: 1;
    id: string;
    title: string;
    artist: string;
    audioUrl: string;
    duration: number;
    bpm: number;
    firstBeatOffset: number;
    beatsPerBar: number;
    beats: readonly Beat[];
    artwork?: string;
    source: string;
    license: string;
}

/** Throws an actionable message rather than accepting partially valid data. */
export function validateManifest(value: unknown): TrackManifest {
    if (!value || typeof value !== "object") throw new Error("The track manifest is missing.");
    const data = value as Record<string, unknown>;
    if (data.schemaVersion !== 1) throw new Error("This track manifest version is not supported.");
    for (const key of ["id", "title", "artist", "audioUrl", "source", "license"] as const) {
        if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > 2048) {
            throw new Error(`The track manifest needs a valid ${key}.`);
        }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(data.id as string) ||
        data.id === "constructor" || data.id === "prototype") {
        throw new Error("Track ID must be a safe identifier of at most 128 characters.");
    }
    if (typeof data.duration !== "number" || !Number.isFinite(data.duration) ||
        data.duration <= 0 || data.duration > 21_600) {
        throw new Error("Track duration must be between 0 and 21,600 seconds.");
    }
    if (typeof data.bpm !== "number" || typeof data.firstBeatOffset !== "number" ||
        typeof data.beatsPerBar !== "number") {
        throw new Error("The track needs numeric tempo, first-beat offset, and beats per bar.");
    }
    validateTempo(data.bpm, data.firstBeatOffset, data.beatsPerBar);
    if (data.firstBeatOffset >= data.duration) {
        throw new Error("The first beat must occur before the audio ends.");
    }
    validateTimeline(data.beats as Beat[], data.duration);
    if ((data.beats as Beat[])[0]!.time !== data.firstBeatOffset) {
        throw new Error("The first beat timestamp must match the first-beat offset.");
    }
    if (data.artwork !== undefined && typeof data.artwork !== "string") {
        throw new Error("Track artwork must be a URL string.");
    }
    return data as unknown as TrackManifest;
}

export const DEMO_TRACK: TrackManifest = validateManifest(demoManifest);
export const BUNDLED_TRACKS: readonly TrackManifest[] = [DEMO_TRACK];

/** Six hours of authored ticks; practice sessions can be reset at any time. */
export function createPracticeTrack(bpm = 120): TrackManifest {
    const duration = 21_600;
    return {
        schemaVersion: 1,
        id: `practice-${bpm}`,
        title: "Open Dojo",
        artist: "Generated metronome",
        audioUrl: "metronome:practice",
        duration,
        bpm,
        firstBeatOffset: 0,
        beatsPerBar: 4,
        beats: generateTimeline(duration, bpm),
        source: "Web Audio sine-wave metronome",
        license: "CC0-1.0",
    };
}

export interface LoadedTrack {
    manifest: TrackManifest;
    buffer: AudioBuffer;
    /** Releases this import's object URL; safe to call more than once. */
    dispose(): void;
}

export interface PreparedLocalAudio {
    file: File;
    buffer: AudioBuffer;
    /** SHA-256 of the selected file, before decodeAudioData can detach its bytes. */
    contentHash: string;
}

type Decoder = Pick<AudioContext, "decodeAudioData">;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Analysis adds mono PCM, model tensors and GPU memory to the playback buffer.
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

/** Stable metadata identity, not a content fingerprint or a security hash. */
export function localTrackId(file: Pick<File, "name" | "size" | "lastModified">): string {
    const bytes = new TextEncoder().encode(JSON.stringify([file.name, file.size, file.lastModified]));
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return `local-${hash.toString(16).padStart(16, "0")}`;
}

function abortError(): DOMException {
    return new DOMException("A newer track selection replaced this load.", "AbortError");
}

/**
 * Owns pending loads and local object URLs. Loading never uploads a local file.
 * decodeAudioData itself cannot be aborted; its result is ignored on cancellation.
 */
export class TrackLoader {
    private readonly context: Decoder;
    private pending: AbortController | null = null;
    private owned = new Set<LoadedTrack>();
    private disposed = false;
    private prepared?: PreparedLocalAudio;

    constructor(context: Decoder) {
        this.context = context;
    }

    async load(manifest: TrackManifest): Promise<LoadedTrack> {
        validateManifest(manifest);
        const abort = this.beginLoad();
        try {
            const response = await fetch(manifest.audioUrl, { signal: abort.signal });
            if (!response.ok) {
                throw new Error(`The track could not be downloaded (HTTP ${response.status}). Try again.`);
            }
            const bytes = await response.arrayBuffer();
            this.checkCurrent(abort);
            const buffer = await this.decode(bytes);
            this.checkCurrent(abort);
            if (Math.abs(buffer.duration - manifest.duration) > 0.15) {
                throw new Error("The audio duration does not match its beat manifest. Choose another track.");
            }
            return this.own(manifest, buffer);
        } catch (error) {
            if (abort.signal.aborted) throw abortError();
            throw error;
        } finally {
            if (this.pending === abort) this.pending = null;
        }
    }

    /** One selected file is retained for analysis, preview, play and retry. */
    async prepareLocal(file: File): Promise<PreparedLocalAudio> {
        const abort = this.beginLoad();
        try {
            const prepared = await this.prepare(file, abort);
            this.checkCurrent(abort);
            return prepared;
        } catch (error) {
            if (abort.signal.aborted) throw abortError();
            throw error;
        } finally {
            if (this.pending === abort) this.pending = null;
        }
    }

    clearLocalCache(): void {
        this.prepared = undefined;
    }

    async loadLocal(file: File, bpm: number, firstBeatOffset = 0, analysis?: BeatAnalysis): Promise<LoadedTrack> {
        if (!analysis) validateTempo(bpm, firstBeatOffset);
        const abort = this.beginLoad();
        let objectUrl: string | undefined;
        try {
            const { buffer, contentHash } = await this.prepare(file, abort);
            this.checkCurrent(abort);
            if (analysis && Math.abs(analysis.duration - buffer.duration) > 0.05) {
                throw new Error("The analysis does not match this file. Analyze the selected track again.");
            }
            const chart = analysis ? createAnalyzedChart(analysis) : undefined;
            const beats = chart?.beats ?? generateTimeline(buffer.duration, bpm, firstBeatOffset);
            objectUrl = URL.createObjectURL(file);
            const manifest = validateManifest({
                schemaVersion: 1,
                id: chart ? `analyzed-${contentHash}-${chart.chartHash}` : localTrackId(file),
                title: file.name.replace(/\.[^.]+$/, ""),
                artist: "Local file · this session only",
                audioUrl: objectUrl,
                duration: buffer.duration,
                bpm: chart?.bpm ?? bpm,
                firstBeatOffset: chart?.firstBeatOffset ?? firstBeatOffset,
                beatsPerBar: chart?.beatsPerBar ?? 4,
                beats,
                source: `User-selected file: ${file.name}`,
                license: "User-provided; never uploaded or redistributed",
            });
            const loaded = this.own(manifest, buffer, objectUrl);
            objectUrl = undefined;
            return loaded;
        } catch (error) {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            if (abort.signal.aborted) throw abortError();
            throw error;
        } finally {
            if (this.pending === abort) this.pending = null;
        }
    }

    cancel(): void {
        this.pending?.abort();
        this.pending = null;
    }

    dispose(): void {
        this.cancel();
        for (const loaded of this.owned) loaded.dispose();
        this.owned.clear();
        this.prepared = undefined;
        this.disposed = true;
    }

    private async prepare(file: File, abort: AbortController): Promise<PreparedLocalAudio> {
        if (!file || !file.size) throw new Error("Choose a non-empty audio file from your device.");
        if (file.size > MAX_FILE_BYTES) throw new Error("Choose an audio file smaller than 100 MB.");
        if (this.prepared?.file === file) return this.prepared;
        this.prepared = undefined;
        const bytes = await file.arrayBuffer();
        this.checkCurrent(abort);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        this.checkCurrent(abort);
        const buffer = await this.decode(bytes);
        this.checkCurrent(abort);
        if (buffer.duration > 21_600) {
            throw new Error("Choose an audio file no longer than 6 hours (21,600 seconds).");
        }
        if (buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_BYTES) {
            throw new Error("This track needs too much decoded audio memory. Choose a shorter file (about 11 minutes at 48 kHz stereo).");
        }
        const contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        this.prepared = { file, buffer, contentHash };
        return this.prepared;
    }

    private beginLoad(): AbortController {
        if (this.disposed) throw new Error("This audio loader has already been disposed.");
        this.cancel();
        this.pending = new AbortController();
        return this.pending;
    }

    private checkCurrent(abort: AbortController): void {
        if (abort.signal.aborted || this.pending !== abort) throw abortError();
    }

    private async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
        try {
            return await this.context.decodeAudioData(bytes);
        } catch {
            throw new Error("This audio file could not be decoded. Try a WAV, MP3, Ogg, or M4A file supported by your browser.");
        }
    }

    private own(manifest: TrackManifest, buffer: AudioBuffer, objectUrl?: string): LoadedTrack {
        let released = false;
        const loaded: LoadedTrack = {
            manifest,
            buffer,
            dispose: () => {
                if (released) return;
                released = true;
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                this.owned.delete(loaded);
            },
        };
        this.owned.add(loaded);
        return loaded;
    }
}
