import { safeId, textField, validHash, type LibraryTrack, type ChartRevision } from "../library/types";

export interface PlaylistSlot { id: string; trackId: string }
export interface Playlist {
    schemaVersion: 1;
    id: string;
    name: string;
    slots: PlaylistSlot[];
    createdAt: number;
    updatedAt: number;
}
export interface PinnedSong {
    slotId: string;
    trackId: string;
    audioHash: string;
    chartId: string;
    title: string;
    artist: string;
    duration: number;
    timing: ChartRevision["timing"];
}
export interface PlaylistReadiness {
    ready: boolean;
    duration: number;
    blocked: { slotId: string; trackId: string; reason: string }[];
}

export function validatePlaylist(value: unknown): Playlist {
    if (!value || typeof value !== "object") throw new Error("Invalid playlist.");
    const p = value as Playlist;
    if (p.schemaVersion !== 1 || !safeId(p.id) || !Array.isArray(p.slots) || p.slots.length > 100 ||
        !Number.isFinite(p.createdAt) || p.createdAt < 0 || !Number.isFinite(p.updatedAt) || p.updatedAt < 0) {
        throw new Error("This playlist is invalid or unsupported.");
    }
    const seen = new Set<string>();
    const slots = p.slots.map(slot => {
        if (!slot || !safeId(slot.id) || !validHash(slot.trackId) || seen.has(slot.id)) {
            throw new Error("Each playlist slot needs a distinct ID and a valid track reference.");
        }
        seen.add(slot.id);
        return { id: slot.id, trackId: slot.trackId };
    });
    return { schemaVersion: 1, id: p.id, name: textField(p.name, "playlist name"), slots,
        createdAt: p.createdAt, updatedAt: p.updatedAt };
}

export function playlistReadiness(playlist: Playlist, tracks: readonly LibraryTrack[]): PlaylistReadiness {
    const byId = new Map(tracks.map(track => [track.id, track]));
    let duration = 0;
    const blocked: PlaylistReadiness["blocked"] = [];
    for (const slot of playlist.slots) {
        const track = byId.get(slot.trackId);
        if (track?.duration) duration += track.duration;
        const reason = !track ? "Track is missing from the library."
            : !track.audioAvailable ? "Relink the original audio file."
            : !track.chartId || !track.duration ? "This track needs a usable beat chart."
            : undefined;
        if (reason) blocked.push({ ...slot, slotId: slot.id, reason });
    }
    if (!playlist.slots.length) blocked.push({ slotId: "", trackId: "", reason: "Add songs to this playlist." });
    return { ready: !blocked.length, duration, blocked };
}

/** Copies identities and metadata; later edits cannot modify a run's song order. */
export function pinPlaylist(
    playlist: Playlist, tracks: readonly LibraryTrack[], charts: readonly ChartRevision[],
): PinnedSong[] {
    const readiness = playlistReadiness(playlist, tracks);
    if (!readiness.ready) throw new Error(readiness.blocked.map(item => item.reason).join(" "));
    const byTrack = new Map(tracks.map(track => [track.id, track]));
    const byChart = new Map(charts.map(chart => [chart.id, chart]));
    return playlist.slots.map(slot => {
        const track = byTrack.get(slot.trackId)!;
        const chart = byChart.get(track.chartId!);
        if (!chart || chart.trackId !== track.id || Math.abs(chart.manifest.duration - track.duration!) > 0.05) {
            throw new Error(`The chart for ${track.title} is missing or invalid. Retry its analysis.`);
        }
        return { slotId: slot.id, trackId: track.id, audioHash: track.contentHash, chartId: chart.id,
            title: track.title, artist: track.artist, duration: chart.manifest.duration, timing: chart.timing };
    });
}
