import { createCombat, type CombatState, type CombatTuning } from "../combat";
import {
    encounterReward, generateEncounterOffers, isEncounterId, type EncounterId,
} from "../encounters/catalog";
import { safeId, textField, validHash } from "../library/types";
import type { PinnedSong } from "../playlists";
import { chooseUpgrade, prepareUpgradeChoices, queueUpgradeLevels, type UpgradeId } from "../upgrades";
import {
    experienceAtTotal, natural, restoreProgression, snapshotProgression, validateProgression,
    type RunProgression,
} from "./progression";

export const RUN_SCHEMA_VERSION = 1;
/** Bump for incompatible upgrade, XP, encounter or reward definitions. */
export const RUN_RULES_VERSION = 1;
export type RunSong = PinnedSong;
export type RunStatus = "starting" | "choosing-arena" | "song-active" | "intermission" |
    "completed" | "defeated" | "abandoned";

export interface SongEntry {
    songIndex: number;
    encounterId: EncounterId;
    combatSeed: number;
    entryRequiredXp: number;
    progression: RunProgression;
}
export interface ClearedSong {
    songIndex: number;
    encounterId: EncounterId;
    ordinaryXp: number;
    bankedXp: number;
    bonusXp: number;
    eliteDefeated: boolean;
    score: number;
    kills: number;
    totalXp: number;
}
export interface RunRecord {
    schemaVersion: typeof RUN_SCHEMA_VERSION;
    rulesVersion: typeof RUN_RULES_VERSION;
    id: string;
    title: string;
    seed: number;
    revision: number;
    status: RunStatus;
    songIndex: number;
    songs: RunSong[];
    map: EncounterId[][];
    progression: RunProgression;
    entry?: SongEntry;
    route: ClearedSong[];
    initialChoiceCompleted: boolean;
    createdAt: number;
    updatedAt: number;
}
export type RunState = RunRecord;

export function isTerminalRun(run: Pick<RunRecord, "status">): boolean {
    return run.status === "completed" || run.status === "defeated" || run.status === "abandoned";
}

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function songSeed(seed: number, index: number): number {
    let value = (seed ^ 0xB5297A4D ^ Math.imul(index + 1, 0x68E31DA4)) >>> 0;
    value = Math.imul(value ^ value >>> 16, 0x85EBCA6B);
    value = Math.imul(value ^ value >>> 13, 0xC2B2AE35);
    return (value ^ value >>> 16) >>> 0;
}

function songsFrom(value: unknown): RunSong[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
        throw new Error("A run needs between one and 100 song slots.");
    }
    const seen = new Set<string>();
    return value.map(song => {
        if (!song || !safeId(song.slotId) || seen.has(song.slotId) ||
            !validHash(song.trackId) || song.audioHash !== song.trackId || !safeId(song.chartId) ||
            !Number.isFinite(song.duration) || song.duration <= 0 || song.duration > 21_600 ||
            !["manual", "analyzed"].includes(song.timing)) throw new Error("Invalid pinned run song.");
        seen.add(song.slotId);
        return {
            slotId: song.slotId, trackId: song.trackId, audioHash: song.audioHash, chartId: song.chartId,
            title: textField(song.title, "song title"), artist: textField(song.artist, "artist"),
            duration: song.duration, timing: song.timing,
        };
    });
}

/** Check compatibility before interpreting saved ranks, cards, maps or rewards. */
export function validateRunRecord(value: unknown): RunRecord {
    if (!value || typeof value !== "object") throw new Error("Invalid run checkpoint.");
    const raw = value as RunRecord;
    if (raw.schemaVersion !== RUN_SCHEMA_VERSION || raw.rulesVersion !== RUN_RULES_VERSION) {
        throw new Error("This run uses unsupported save or gameplay rules. Keep its recovery file.");
    }
    const run = structuredClone(raw);
    if (!safeId(run.id) || !["starting", "choosing-arena", "song-active", "intermission",
        "completed", "defeated", "abandoned"].includes(run.status) ||
        typeof run.initialChoiceCompleted !== "boolean") throw new Error("Invalid run identity or state.");
    run.title = textField(run.title, "run title");
    natural(run.seed, "seed", 0xFFFFFFFF);
    natural(run.revision, "revision");
    natural(run.songIndex, "song index");
    for (const field of ["createdAt", "updatedAt"] as const) {
        if (!Number.isFinite(run[field]) || run[field] < 0) throw new Error("Invalid run timestamp.");
    }
    if (run.updatedAt < run.createdAt) throw new Error("Invalid run timestamp order.");
    run.songs = songsFrom(run.songs);
    if (run.songIndex > run.songs.length || (run.songIndex === run.songs.length && run.status !== "completed")) {
        throw new Error("The run's current song is out of bounds.");
    }
    const expectedMap = generateEncounterOffers(run.seed, run.songs.length);
    if (JSON.stringify(run.map) !== JSON.stringify(expectedMap)) throw new Error("The run's saved arena offers are invalid.");
    run.map = expectedMap.map(row => [...row]);
    run.progression = validateProgression(run.progression);
    if (!Array.isArray(run.route) || run.route.length !== run.songIndex) throw new Error("Invalid completed run route.");
    for (let i = 0; i < run.route.length; i++) {
        const clear = run.route[i]!;
        if (!clear || clear.songIndex !== i || !isEncounterId(clear.encounterId) ||
            !run.map[i]!.includes(clear.encounterId) || typeof clear.eliteDefeated !== "boolean") {
            throw new Error("Invalid completed encounter.");
        }
        for (const field of ["ordinaryXp", "bankedXp", "bonusXp", "score", "kills", "totalXp"] as const) {
            natural(clear[field], `route ${field}`);
        }
        if (clear.bankedXp > clear.ordinaryXp || clear.totalXp > run.progression.experience.totalXp ||
            (i > 0 && clear.totalXp < run.route[i - 1]!.totalXp)) throw new Error("Invalid route reward totals.");
    }
    const pending = run.progression.upgrades.pending;
    const chosen = Object.values(run.progression.upgrades.ranks).reduce((sum, rank) => sum + rank, 0);
    if (!run.initialChoiceCompleted && (run.songIndex !== 0 || chosen !== 0 ||
        run.progression.experience.level !== 1 || pending !== 1 ||
        !["starting", "abandoned"].includes(run.status))) throw new Error("Invalid starting upgrade checkpoint.");
    if (run.initialChoiceCompleted && (chosen < 1 || run.status === "starting")) throw new Error("Starting upgrade is missing.");
    if ((run.status === "choosing-arena" || run.status === "song-active") && pending !== 0) {
        throw new Error("Resolve pending upgrades before choosing an arena.");
    }
    if (run.status === "intermission" && (pending === 0 || run.songIndex === 0)) throw new Error("Invalid upgrade intermission.");
    if (run.status === "completed" && run.songIndex !== run.songs.length) throw new Error("The run is not complete.");
    if (run.entry) {
        if (run.entry.songIndex !== run.songIndex || !isEncounterId(run.entry.encounterId) ||
            !run.map[run.songIndex]?.includes(run.entry.encounterId) ||
            run.entry.combatSeed !== songSeed(run.seed, run.songIndex) ||
            !["song-active", "defeated", "abandoned"].includes(run.status)) throw new Error("Invalid song-entry checkpoint.");
        run.entry.progression = validateProgression(run.entry.progression);
        if (run.entry.entryRequiredXp !== run.entry.progression.experience.requiredXp) throw new Error("Invalid entry XP requirement.");
        if (run.status === "song-active" && JSON.stringify(run.entry.progression) !== JSON.stringify(run.progression)) {
            throw new Error("An active song must retain its entry progression.");
        }
    } else if (run.status === "song-active" || run.status === "defeated") throw new Error("Missing song-entry checkpoint.");
    return freeze(run);
}
export const validateRun = validateRunRecord;

export interface CreateRunOptions {
    id: string;
    title: string;
    songs: readonly RunSong[];
    seed: number;
    now?: number;
}
export function createRun(options: CreateRunOptions): RunRecord {
    const combat = createCombat(options.seed);
    combat.upgrades.pending = 1;
    prepareUpgradeChoices(combat);
    const now = options.now ?? Date.now();
    return validateRunRecord({
        schemaVersion: RUN_SCHEMA_VERSION, rulesVersion: RUN_RULES_VERSION,
        id: options.id, title: options.title, seed: options.seed, revision: 0,
        status: "starting", songIndex: 0, songs: [...options.songs],
        map: generateEncounterOffers(options.seed, options.songs.length),
        progression: snapshotProgression(combat), route: [], initialChoiceCompleted: false,
        createdAt: now, updatedAt: now,
    });
}

function transition(run: RunRecord, changes: Partial<RunRecord>): RunRecord {
    if (isTerminalRun(run)) throw new Error("This run has ended.");
    return validateRunRecord({
        ...run, ...changes, revision: run.revision + 1, updatedAt: Math.max(run.updatedAt, Date.now()),
    });
}

export function restoreRunCombat(run: RunRecord, tuning: Partial<CombatTuning> = {}): CombatState {
    if (run.rulesVersion !== RUN_RULES_VERSION || run.schemaVersion !== RUN_SCHEMA_VERSION) {
        throw new Error("This run uses unsupported gameplay rules.");
    }
    return restoreProgression(run.status === "song-active" ? run.entry!.progression : run.progression,
        run.entry?.combatSeed ?? songSeed(run.seed, run.songIndex), tuning);
}

export function chooseRunUpgrade(run: RunRecord, id: UpgradeId, offeredLevel: number): RunRecord {
    if (run.status !== "starting" && run.status !== "intermission") throw new Error("This run is not choosing an upgrade.");
    const combat = restoreRunCombat(run);
    if (combat.upgrades.offeredLevel !== offeredLevel || !chooseUpgrade(combat, id, 0)) {
        throw new Error("That upgrade offer has expired.");
    }
    if (combat.upgrades.pending) prepareUpgradeChoices(combat);
    return transition(run, {
        initialChoiceCompleted: true,
        status: combat.upgrades.pending ? "intermission" : "choosing-arena",
        progression: snapshotProgression(combat),
    });
}

export function selectRunArena(run: RunRecord, encounterId: EncounterId): RunRecord {
    if (run.status !== "choosing-arena" || !run.map[run.songIndex]?.includes(encounterId)) {
        throw new Error("That arena is not offered for this song.");
    }
    return transition(run, {
        status: "song-active",
        entry: {
            songIndex: run.songIndex, encounterId, combatSeed: songSeed(run.seed, run.songIndex),
            entryRequiredXp: run.progression.experience.requiredXp,
            progression: structuredClone(run.progression),
        },
    });
}

export interface SongSettlement {
    songIndex: number;
    ordinaryXp?: number;
    eliteDefeated?: boolean;
}

/** Bank only existing gems; the caller freezes combat before this atomic transition. */
export function settleRunSong(run: RunRecord, live: CombatState, settlement: SongSettlement): RunRecord {
    if (run.route.some(clear => clear.songIndex === settlement.songIndex)) return run;
    if (run.status !== "song-active" || run.songIndex !== settlement.songIndex || !run.entry) {
        throw new Error("This song is not awaiting settlement.");
    }
    // A fatal final fixed step wins over the transport's completion flag.
    if (live.defeated || live.health <= 0) return defeatRun(run, live);
    const bankedXp = live.experience.drops.reduce((sum, drop) => sum + drop.value, 0);
    natural(bankedXp, "uncollected experience");
    const ordinaryXp = live.experience.totalXp - run.entry.progression.experience.totalXp + bankedXp;
    natural(ordinaryXp, "ordinary experience");
    if (settlement.ordinaryXp !== undefined && settlement.ordinaryXp !== ordinaryXp) {
        throw new Error("The encounter's ordinary XP ledger does not match its collected and dropped XP.");
    }
    const eliteDefeated = settlement.eliteDefeated ?? false;
    const bonusXp = encounterReward(run.entry.encounterId, ordinaryXp, run.entry.entryRequiredXp, eliteDefeated);
    const combat = restoreProgression(snapshotProgression(live), run.entry.combatSeed);
    combat.experience = {
        ...combat.experience,
        ...experienceAtTotal(combat.experience.totalXp + bankedXp + bonusXp, combat.experience.tuning),
    };
    queueUpgradeLevels(combat.upgrades, combat.experience.level);
    if (combat.upgrades.pending) prepareUpgradeChoices(combat);
    const progression = snapshotProgression(combat);
    const next = run.songIndex + 1;
    const clear: ClearedSong = {
        songIndex: run.songIndex, encounterId: run.entry.encounterId,
        ordinaryXp, bankedXp, bonusXp, eliteDefeated, score: combat.score, kills: combat.kills,
        totalXp: combat.experience.totalXp,
    };
    return transition(run, {
        songIndex: next, progression, entry: undefined, route: [...run.route, clear],
        status: next === run.songs.length ? "completed" : combat.upgrades.pending ? "intermission" : "choosing-arena",
    });
}

export function defeatRun(run: RunRecord, live?: CombatState): RunRecord {
    if (run.status === "defeated") return run;
    if (run.status !== "song-active") throw new Error("Only an active song can end in defeat.");
    return transition(run, { status: "defeated", ...(live ? { progression: snapshotProgression(live) } : {}) });
}

export function abandonRun(run: RunRecord): RunRecord {
    if (run.status === "abandoned") return run;
    return transition(run, { status: "abandoned" });
}
