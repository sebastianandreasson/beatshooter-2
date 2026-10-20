import { describe, expect, test } from "bun:test";
import { generateTimeline, type Beat } from "../rhythm/timeline";
import {
    advanceHazards, createHazards, gridTiles, intersectsTile, warningWindow,
} from "./state";

describe("authored warning windows", () => {
    test("fast bars extend until both one complete bar and one song second have elapsed", () => {
        const beats = generateTimeline(10, 300);
        const window = warningWindow(beats, 0, 10)!;
        expect(window.startTime).toBe(0);
        expect(window.strikeTime).toBeCloseTo(1.6);
        expect(beats[window.strikeIndex]!.downbeat).toBe(true);
        expect(beats[window.strikeIndex]!.bar).toBe(2);
        expect(warningWindow(beats, 1, 10)).toBeUndefined();
    });

    test("variable tempo and irregular meter use actual accents, not a four-beat estimate", () => {
        const times = [0, 0.22, 0.41, 0.67, 0.9, 1.08, 1.39, 1.74, 2.12];
        const beats: Beat[] = times.map((time, index) => ({
            time, index, bar: Math.floor(index / 3), beatInBar: index % 3, downbeat: index % 3 === 0,
        }));
        expect(warningWindow(beats, 0, 3)?.strikeTime).toBe(1.39);
        const slow = generateTimeline(60, 20);
        expect(warningWindow(slow, 0, 60)?.strikeTime).toBe(12);
    });

    test("gaps, the final bar and a missing recovery beat suppress a warning", () => {
        const beats = generateTimeline(5, 120);
        expect(warningWindow(beats, 8, 5)).toBeUndefined();
        const gap = beats.map(beat => ({ ...beat, time: beat.time + (beat.index >= 2 ? 4 : 0) }));
        expect(warningWindow(gap, 0, 10)).toBeUndefined();
        expect(warningWindow(beats.slice(0, 5), 0, 5)).toBeUndefined();
    });
});

describe("Pulse Grid", () => {
    test("patterns have eight isolated tiles, connected corridors, a clear cross and outer walkway", () => {
        for (const pattern of [0, 1]) {
            const tiles = gridTiles(pattern);
            expect(tiles).toHaveLength(8);
            for (const tile of tiles) {
                expect(Math.abs(tile.x)).toBeGreaterThan(3);
                expect(Math.abs(tile.z)).toBeGreaterThan(3);
                expect(Math.abs(tile.x) + tile.width / 2).toBeLessThan(15);
                expect(Math.abs(tile.z) + tile.depth / 2).toBeLessThan(15);
                expect(intersectsTile(tile, 0.55, tile)).toBe(true);
            }
            // Every corridor intersection remains traversable by the full ship circle.
            for (const x of [-16, -9, 0, 9, 16]) for (let z = -17; z <= 17; z += 0.25) {
                expect(tiles.some(tile => intersectsTile({ x, z }, 0.55, tile))).toBe(false);
                expect(tiles.some(tile => intersectsTile({ x: z, z: x }, 0.55, tile))).toBe(false);
            }
        }
        expect(gridTiles(0).some(tile => gridTiles(1).some(other => tile.x === other.x && tile.z === other.z))).toBe(false);
    });

    test("a strike occurs exactly once; held time and missing strike delivery cannot replay it", () => {
        const beats = generateTimeline(30, 120), state = createHazards();
        for (const beat of beats.slice(0, 9)) advanceHazards(state, beats, beat, 30, 0);
        const warning = structuredClone(state.grid)!;
        expect(warning.startTime).toBe(4);
        expect(warning.strikeTime).toBe(6);
        expect(state.pendingStrikes).toHaveLength(0);
        advanceHazards(state, beats, beats[12]!, 30, 0);
        advanceHazards(state, beats, beats[12]!, 30, 0);
        expect(state.pendingStrikes).toHaveLength(1);
        expect(state.grid?.phase).toBe("active");
        advanceHazards(state, beats, beats[13]!, 30, 0);
        expect(state.grid).toBeUndefined();

        const skipped = createHazards();
        for (const beat of beats.slice(0, 9)) advanceHazards(skipped, beats, beat, 30, 0);
        advanceHazards(skipped, beats, beats[13]!, 30, 0);
        expect(skipped.pendingStrikes).toHaveLength(0);
        expect(skipped.grid).toBeUndefined();
    });
});
