import type { Beat } from "../rhythm/timeline";

export const MAX_AUTHORED_GAP = 3.05;
export const GRID_HAZARD_CAP = 8;
export const GRID_TILE_WIDTH = 4.5;

export interface WarningWindow {
    startIndex: number;
    startTime: number;
    strikeIndex: number;
    strikeTime: number;
    endTime: number;
}
export interface HazardTile { x: number; z: number; width: number; depth: number }
export interface GridWarning extends WarningWindow {
    id: number;
    tiles: readonly HazardTile[];
    phase: "warning" | "active" | "recover";
}
export interface HazardState {
    grid?: GridWarning;
    pendingStrikes: HazardTile[][];
    nextAt: number;
    pattern: number;
    sequence: number;
}
export function createHazards(seed = 0): HazardState {
    return { pendingStrikes: [], nextAt: 3, pattern: seed & 1, sequence: 0 };
}

/**
 * Warnings begin on accents, span a complete authored bar and at least one
 * song second, and strike on a later accent. Unsupported gaps cancel them.
 */
export function warningWindow(
    beats: readonly Beat[], startIndex: number, duration: number,
): WarningWindow | undefined {
    const start = beats[startIndex];
    if (!start?.downbeat || start.index !== startIndex) return;
    for (let index = startIndex + 1; index < beats.length; index++) {
        const previous = beats[index - 1]!, beat = beats[index]!;
        if (beat.time - previous.time > MAX_AUTHORED_GAP) return;
        if (!beat.downbeat || beat.bar <= start.bar || beat.time - start.time < 1 - 1e-8) continue;
        const next = beats[index + 1];
        if (!next || next.time >= duration || next.time - beat.time > MAX_AUTHORED_GAP) return;
        return {
            startIndex, startTime: start.time, strikeIndex: beat.index,
            strikeTime: beat.time, endTime: next.time,
        };
    }
}

/**
 * Eight isolated 4.5-unit tiles leave 1.5-unit corridors between every tile,
 * a 7.5-unit central cross and an outer walkway. A player of diameter 1.1
 * can escape any tile without requiring a dash or passing another danger tile.
 */
export function gridTiles(pattern: number): HazardTile[] {
    const positions = [-12, -6, 6, 12];
    const tiles: HazardTile[] = [];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        if ((row + col + pattern) % 2 === 0) {
            tiles.push({ x: positions[col]!, z: positions[row]!, width: GRID_TILE_WIDTH, depth: GRID_TILE_WIDTH });
        }
    }
    return tiles;
}

export function intersectsTile(point: { x: number; z: number }, radius: number, tile: HazardTile): boolean {
    const dx = Math.max(0, Math.abs(point.x - tile.x) - tile.width / 2);
    const dz = Math.max(0, Math.abs(point.z - tile.z) - tile.depth / 2);
    return dx * dx + dz * dz <= radius * radius;
}

export function advanceHazards(
    state: HazardState, beats: readonly Beat[], beat: Beat, duration: number, stageIndex: number,
): void {
    const grid = state.grid;
    if (grid) {
        if (beat.index === grid.strikeIndex && grid.phase === "warning") {
            grid.phase = "active";
            // Only the current strike can affect the next physics step.
            state.pendingStrikes.length = 0;
            state.pendingStrikes.push([...grid.tiles]);
        } else if (beat.index > grid.strikeIndex && grid.phase === "warning") {
            // A missing accepted strike never catches up later.
            state.grid = undefined;
        } else if (beat.time >= grid.endTime) {
            state.grid = undefined;
        }
    }
    if (state.grid || !beat.downbeat || beat.time < state.nextAt) return;
    const window = warningWindow(beats, beat.index, duration);
    if (!window) return;
    state.grid = { ...window, id: ++state.sequence, tiles: gridTiles(state.pattern++), phase: "warning" };
    state.nextAt = window.endTime + Math.max(4, 7 - Math.min(9, stageIndex) / 3);
}
