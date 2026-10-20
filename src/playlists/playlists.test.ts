import { describe, expect, test } from "bun:test";
import { playlistReadiness, validatePlaylist } from ".";
import type { LibraryTrack } from "../library/types";

const track = {
    schemaVersion: 1, id: "a".repeat(64), contentHash: "a".repeat(64), title: "Pulse", artist: "Local",
    fileName: "pulse.wav", mime: "audio/wav", size: 10, lastModified: 1, createdAt: 1, updatedAt: 1,
    jobRevision: 0, duration: 120, status: "ready", audioAvailable: true, chartId: "chart-test",
} satisfies LibraryTrack;

describe("ordered playlists", () => {
    test("explicit repeated slots preserve order and count every full song duration", () => {
        const playlist = validatePlaylist({ schemaVersion: 1, id: "set", name: "Test set", createdAt: 1, updatedAt: 1,
            slots: [{ id: "second", trackId: track.id }, { id: "first", trackId: track.id }] });
        expect(playlist.slots.map(slot => slot.id)).toEqual(["second", "first"]);
        expect(playlistReadiness(playlist, [track])).toEqual({ ready: true, duration: 240, blocked: [] });
    });
    test("missing audio, missing timing and empty playlists explain readiness independently", () => {
        const playlist = validatePlaylist({ schemaVersion: 1, id: "set", name: "Test set", createdAt: 1, updatedAt: 1,
            slots: [{ id: "slot", trackId: track.id }] });
        expect(playlistReadiness(playlist, [{ ...track, audioAvailable: false }]).blocked[0]!.reason).toContain("Relink");
        expect(playlistReadiness(playlist, [{ ...track, chartId: undefined }]).blocked[0]!.reason).toContain("chart");
        expect(playlistReadiness(playlist, []).blocked[0]!.reason).toContain("missing");
        expect(playlistReadiness({ ...playlist, slots: [] }, [track]).ready).toBe(false);
    });
    test("duplicate slot identity and unknown schemas are rejected", () => {
        const base = { schemaVersion: 1, id: "set", name: "Test set", createdAt: 1, updatedAt: 1,
            slots: [{ id: "slot", trackId: track.id }, { id: "slot", trackId: track.id }] };
        expect(() => validatePlaylist(base)).toThrow("distinct");
        expect(() => validatePlaylist({ ...base, schemaVersion: 2 })).toThrow("unsupported");
    });
});
