import { type Resource, type World } from "@dylanebert/shallot";
import { AudioOutput } from "@dylanebert/shallot/audio";
import { MusicLibrary } from "../library";
import { RunStore } from "../run/store";
import {
    createRun, chooseRunUpgrade, selectRunArena, restoreRunCombat, settleRunSong,
    defeatRun, abandonRun, isTerminalRun, type RunRecord, type RunSong,
} from "../run";
import { ENCOUNTERS, isEncounterId } from "../encounters/catalog";
import { configureEncounter } from "../encounters";
import { mountJourneyUI, type JourneyView } from "../ui/journey";
import { describeUpgrade, UPGRADE_IDS, type UpgradeId } from "../upgrades";
import { PlayerState } from "../player";
import { Session, startSession, quitSession, clearSession, pauseSession, audio, stopPreview, cancelAnalysis, renderUI } from ".";
import type { BeatAnalysis } from "../analysis/types";

interface JourneyData {
    library?: MusicLibrary; store?: RunStore; active?: RunRecord; current?: RunRecord;
    ui?: ReturnType<typeof mountJourneyUI>; initializing?: Promise<void>; initialized: boolean; open: boolean; busy: boolean;
    error?: string; notice?: string; previewTrackId?: string; retrySave?: () => Promise<void>; unsubscribe?: () => void;
}
export const Journey: Resource<JourneyData> = {
    create: () => ({ initialized: false, open: false, busy: false }),
};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function initializeJourney(world: World): Promise<void> {
    const j = world.resource(Journey);
    return j.initializing ??= initialize(world);
}
async function initialize(world: World): Promise<void> {
    const j = world.resource(Journey);
    j.initialized = true;
    j.library = new MusicLibrary({ getDecoder: () => {
        const context = world.resource(AudioOutput).context;
        if (!context) throw new Error("Audio decoding is unavailable in this browser.");
        return context;
    } });
    j.unsubscribe = j.library.subscribe(() => renderUI(world));
    await j.library.initialize();
    if (world.signal.aborted) { j.library.dispose(); return; }
    if (j.library.snapshot.available) {
        j.store = new RunStore(j.library.database, { onOwnershipLost: () => {
            pauseSession(world, "Campaign ownership was lost. Return to the menu and reload its saved entry.");
            j.error = "Another tab or a storage interruption took ownership of this run. Continue from its saved entry.";
            renderUI(world);
        } });
        try { j.active = await j.store.activeRecord(); } catch (e) { j.error = message(e); }
    }
    renderUI(world);
}

export function isCampaign(world: World): boolean { return !!world.resource(Journey).current; }
export function campaignRecord(world: World): RunRecord | undefined { return world.resource(Journey).current; }
export function hasSavedCampaign(world: World): boolean { return !!world.resource(Journey).active; }

export async function openJourney(world: World): Promise<void> {
    await initializeJourney(world);
    const j = world.resource(Journey);
    j.open = true;
    cancelAnalysis(world);
    stopPreview(world);
    world.resource(Session).loader?.clearLocalCache();
    if (j.store) { try { j.active = await j.store.activeRecord(); } catch (e) { j.error = message(e); } }
    // Ask only when the player first enters their library; refusal does not block it.
    void j.library?.requestPersistence();
    renderUI(world);
}

async function ownRun(world: World): Promise<void> {
    const j = world.resource(Journey);
    if (!j.store) throw new Error("Persistent storage is unavailable. Quick Play and Practice still work.");
    if (!await j.store.acquire()) throw new Error("This campaign is open in another tab. Return there, or close it and try again.");
    j.active = await j.store!.activeRecord();
}

/** Save first, then change visible progression. Failed saves leave the last valid checkpoint untouched. */
async function commitRun(world: World, next: RunRecord, after: () => void | Promise<void>): Promise<void> {
    const j = world.resource(Journey);
    j.busy = true; j.error = undefined;
    let committed = false;
    const attempt = async () => {
        try {
            if (!committed) {
                await j.store!.save(next, next.revision === 0 ? null : next.revision - 1);
                committed = true;
            } else {
                // The save may have succeeded before audio/UI handoff failed.
                // A different owner can advance it while this tab is waiting.
                const saved = await j.store!.get(next.id);
                if (!saved || saved.revision !== next.revision || saved.status !== next.status) {
                    throw new Error("A newer checkpoint exists. Use Reload saved checkpoint to continue from it.");
                }
            }
            if (world.signal.aborted) return;
            j.current = next;
            j.active = isTerminalRun(next) ? undefined : next;
            j.retrySave = undefined;
            j.error = undefined;
            if (!j.store!.ownsRun) throw new Error("Run ownership was lost. Reload the saved checkpoint.");
            await after();
        } catch (e) {
            if (world.signal.aborted) return;
            j.error = `${committed ? "Checkpoint saved; unable to continue" : "Progress was not saved"}: ${message(e)}`;
            j.retrySave = async () => {
                if (world.signal.aborted) return;
                j.busy = true; renderUI(world);
                try {
                    if (!j.store!.ownsRun && !await j.store!.acquire()) throw new Error("Another tab still owns this campaign.");
                    await attempt();
                } finally { j.busy = false; if (!world.signal.aborted) renderUI(world); }
            };
            world.resource(Session).phase = "settling";
            j.open = true;
            throw e;
        } finally { j.busy = false; if (!world.signal.aborted) renderUI(world); }
    };
    renderUI(world);
    await attempt();
}

async function showRunBoundary(world: World): Promise<void> {
    const j = world.resource(Journey), s = world.resource(Session), run = j.current!;
    j.open = false; j.notice = undefined;
    const finishedPosition = s.position;
    clearSession(world);
    s.loaded?.dispose(); s.loaded = undefined;
    s.error = undefined;
    s.combat = restoreRunCombat(run);
    s.generation++;
    if (run.status === "starting") s.phase = "starting";
    else if (run.status === "intermission") s.phase = "intermission";
    else if (run.status === "choosing-arena") { s.phase = "map"; j.open = true; }
    else if (run.status === "song-active") await loadCampaignSong(world);
    else {
        s.phase = "results";
        s.position = finishedPosition;
        s.result = run.status === "completed" ? "complete" : "defeat";
        await j.store!.release();
    }
    renderUI(world);
}

async function loadCampaignSong(world: World): Promise<void> {
    const j = world.resource(Journey), run = j.current!;
    const song = run.songs[run.songIndex]!;
    await startSession(world, { mode: "library", song }, { combat: restoreRunCombat(run), campaign: true });
}

export function configureCampaignCombat(world: World): void {
    const j = world.resource(Journey), s = world.resource(Session), run = j.current;
    if (!run?.entry || run.status !== "song-active") return;
    configureEncounter(s.combat, {
        id: run.entry.encounterId, stageIndex: run.songIndex, duration: s.track.duration,
        beats: s.track.beats, seed: run.entry.combatSeed, entryNextLevelXp: run.entry.entryRequiredXp,
    });
}

export async function continueCampaign(world: World): Promise<void> {
    await initializeJourney(world);
    const j = world.resource(Journey);
    if (j.busy) return;
    if (j.retrySave) throw new Error("Retry the failed save or reload the committed checkpoint first.");
    j.busy = true; j.error = undefined;
    try {
        await ownRun(world);
        if (!j.active) throw new Error("There is no active campaign to continue.");
        quitSession(world, true);
        j.current = j.active;
        await j.library!.setGameplayActive(true);
        await showRunBoundary(world);
    } catch (e) { j.error = message(e); j.open = true; if (!j.current && !j.retrySave) await j.store?.release(); throw e; }
    finally { j.busy = false; renderUI(world); }
}

async function startCampaign(world: World, playlistId: string): Promise<void> {
    const j = world.resource(Journey);
    if (j.busy) return;
    if (j.retrySave) throw new Error("Retry the failed save or reload the committed checkpoint first.");
    j.busy = true; renderUI(world);
    try {
        await ownRun(world);
        if (j.active) throw new Error("Abandon your active campaign before starting a new one.");
        const songs = await j.library!.pinPlaylist(playlistId);
        const playlist = j.library!.snapshot.playlists.find(p => p.id === playlistId)!;
        quitSession(world, true);
        const run = createRun({ id: `run-${crypto.randomUUID()}`, title: playlist.name, songs,
            seed: crypto.getRandomValues(new Uint32Array(1))[0]! });
        await j.library!.setGameplayActive(true);
        await commitRun(world, run, () => showRunBoundary(world));
    } catch (e) {
        if (!j.current && !j.retrySave) await j.store?.release();
        throw e;
    } finally { j.busy = false; renderUI(world); }
}

export function selectCampaignUpgrade(world: World, id: string, offeredLevel: number): boolean {
    const j = world.resource(Journey), run = j.current;
    if (!run || j.busy || (run.status !== "starting" && run.status !== "intermission")) return false;
    try {
        const next = chooseRunUpgrade(run, id as UpgradeId, offeredLevel);
        void commitRun(world, next, async () => {
            await new Promise(resolve => setTimeout(resolve, Math.min(900, 90_000 / Math.max(20, world.resource(Session).track.bpm))));
            if (world.signal.aborted) return;
            if (j.current !== next || !j.store?.ownsRun) throw new Error("Run ownership changed while confirming the upgrade.");
            await showRunBoundary(world);
        }).catch(() => {});
        return true;
    } catch (e) { j.error = message(e); renderUI(world); return false; }
}

export function finishCampaignSong(world: World, result: "complete" | "defeat"): void {
    const j = world.resource(Journey), s = world.resource(Session), run = j.current;
    if (!run || run.status !== "song-active" || j.busy) return;
    s.phase = "settling";
    s.transport?.stop(); s.pending.length = 0;
    world.resource(PlayerState).enabled = false;
    world.resource(PlayerState).keys.clear();
    world.pause(); world.setTimeScale(1);
    const next = result === "defeat" ? defeatRun(run, s.combat)
        : settleRunSong(run, s.combat, { songIndex: run.songIndex, eliteDefeated: s.combat.encounter?.eliteDefeated });
    void commitRun(world, next, () => showRunBoundary(world)).catch(() => {});
}

export function leaveCampaign(world: World): void {
    const j = world.resource(Journey);
    // Song entry was committed before playback. Never save volatile mid-song XP.
    j.current = undefined;
    j.open = false;
    j.library?.setGameplayActive(false);
    void j.store?.release();
}

export async function beforeQuickPlay(world: World): Promise<void> {
    leaveCampaign(world);
    await initializeJourney(world);
    await world.resource(Journey).library?.setGameplayActive(true);
}

export async function loadLibrarySong(world: World, song: RunSong) {
    const library = world.resource(Journey).library;
    if (!library) throw new Error("The music library is not ready.");
    const loaded = await library.loadRevision(song.chartId);
    loaded.manifest = { ...loaded.manifest, title: song.title, artist: song.artist };
    return loaded;
}

export async function retainLocalFile(world: World, file: File, analysis?: BeatAnalysis, timing?: { bpm: number; offset: number; duration?: number }): Promise<void> {
    await initializeJourney(world);
    const j = world.resource(Journey);
    if (!j.library?.snapshot.available) return;
    try {
        await j.library.persistAnalyzed(file, analysis, timing);
    } catch (e) {
        j.notice = `This song can still play, but was not added to your library: ${message(e)}`;
    }
}

const restoredBuilds = new WeakMap<RunRecord, ReturnType<typeof restoreRunCombat>>();
function journeyView(world: World): JourneyView {
    const j = world.resource(Journey), s = world.resource(Session), snapshot = j.library?.snapshot;
    const run = j.current ?? j.active;
    let progression = run ? restoredBuilds.get(run) : undefined;
    if (run && !progression) { progression = restoreRunCombat(run); restoredBuilds.set(run, progression); }
    const storage = snapshot?.storage;
    return {
        phase: s.phase, open: j.open, busy: j.busy, error: j.error || snapshot?.error, notice: j.notice,
        storage: typeof storage === "string" ? storage : storage ? `${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB used${storage.quota ? ` of ${Math.round(storage.quota / 1024 / 1024)} MB` : ""} · ${storage.persisted ? "Persistent storage granted" : "Browser-managed storage"}` : "Opening local library…",
        available: snapshot?.available ?? false,
        tracks: snapshot?.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, previewing: j.previewTrackId === t.id && (s.preview || s.previewLoading), filename: t.fileName,
            status: t.status, duration: t.duration, bpm: t.bpm, offset: t.firstBeatOffset,
            message: snapshot.progress?.trackId === t.id ? `${snapshot.progress.stage}${snapshot.progress.total ? ` · ${Math.round(snapshot.progress.completed / snapshot.progress.total * 100)}%` : ""}` : t.error, playable: !!t.chartId && t.audioAvailable, missing: !t.audioAvailable,
            protected: !!j.active?.songs.some(song => song.trackId === t.id) })) ?? [],
        playlists: snapshot?.playlists.map(p => ({ id: p.id, name: p.name, trackIds: p.slots.map(slot => slot.trackId) })) ?? [],
        active: run && !isTerminalRun(run) && progression ? { title: run.title, status: run.status,
            songIndex: run.songIndex, total: run.songs.length, level: progression.experience.level,
            xp: progression.experience.xp, requiredXp: progression.experience.requiredXp,
            health: progression.playerStats.effective.maxHealth,
            upgrades: UPGRADE_IDS.filter(id => progression.upgrades.ranks[id] > 0).map(id => `${describeUpgrade(id, progression.upgrades.ranks[id], progression.playerStats.effective).title} R${progression.upgrades.ranks[id]}`),
        } : undefined,
        route: run?.songs.map((song, i) => ({ title: song.title, duration: song.duration, timing: song.timing === "analyzed" ? "Analyzed" : "Manual",
            current: i === run.songIndex, completed: i < run.songIndex ? ENCOUNTERS[run.route[i]!.encounterId].title : undefined })),
        choices: run?.status === "choosing-arena" ? run.map[run.songIndex]!.map(id => {
            const c = ENCOUNTERS[id];
            return { id, name: c.title, description: c.description, pressure: `${c.threat} pressure`,
                reward: id === "elite-hunt" ? "Kill elite + clear song: ½ an entry level of bonus XP"
                    : c.rewardPercent ? `Clear bonus: +${c.rewardPercent}% earned XP (capped at ½ an entry level)` : "Standard XP · Lower pressure" };
        }) : undefined,
        retrySave: !!j.retrySave, campaign: !!j.current,
    };
}

export function renderJourney(world: World): void {
    const j = world.resource(Journey);
    if (j.ui) {
        try {
            const view = journeyView(world);
            const visible = view.open || view.phase === "map" || view.phase === "settling";
            for (const root of document.querySelectorAll<HTMLElement>(".bs-ui:not(.bs-journey-ui)")) {
                const openingCards = root.inert && !visible && (view.phase === "starting" || view.phase === "intermission");
                root.inert = visible;
                if (openingCards) root.querySelector<HTMLElement>('.bs-upgrade-card:not(:disabled)')?.focus({ preventScroll: true });
            }
            j.ui.render(view);
        }
        catch (e) { j.error = message(e); }
    }
}

export function mountJourney(container: HTMLElement, world: World): () => void {
    const j = world.resource(Journey);
    const library = () => { if (!j.library) throw new Error("The library is still opening."); return j.library; };
    j.ui = mountJourneyUI(container, {
        close: () => { if (j.busy || j.retrySave) return; quitSession(world); },
        import: async files => {
            const results = await library().importFiles(files);
            const errors = results.filter(r => r.error).map(r => `${r.fileName}: ${r.error}`);
            if (errors.length) throw new Error(errors.join(" · "));
            const duplicates = results.filter(r => r.duplicate).length;
            j.notice = `${results.length - duplicates} new song${results.length - duplicates === 1 ? "" : "s"} added${duplicates ? ` · ${duplicates} already in your library` : ""}.`;
        },
        preview: async id => {
            const s = world.resource(Session);
            if (s.phase !== "menu" && s.phase !== "map") return;
            const stopping = j.previewTrackId === id && (s.preview || s.previewLoading);
            stopPreview(world);
            if (stopping) { j.notice = undefined; renderUI(world); return; }
            const token = ++s.loadToken;
            j.previewTrackId = id; s.previewLoading = true;
            const { context, transport } = audio(world);
            try {
                await context.resume();
                await library().setGameplayActive(true);
                const t = library().snapshot.tracks.find(t => t.id === id)!;
                const loaded = await library().loadRevision(t.chartId!);
                if (token !== s.loadToken) { loaded.dispose(); return; }
                s.previewLoaded = loaded; s.preview = true; s.previewLoading = false;
                await transport.start({ ...loaded.manifest, buffer: loaded.buffer, metronome: true, countInBeats: 0 });
                if (token !== s.loadToken) return;
                const start = Math.max(0, loaded.manifest.firstBeatOffset - 1);
                if (start > 0) transport.seek(start);
                s.previewUntil = Math.min(loaded.manifest.duration, start + 12);
                j.notice = "Timing preview · 12 seconds with beat and bar clicks.";
            } catch (e) { s.previewLoading = false; stopPreview(world); throw e; }
            renderUI(world);
        },
        quickPlay: async id => {
            const t = library().snapshot.tracks.find(t => t.id === id)!;
            const c = await library().getChart(t.chartId!);
            if (!c) throw new Error("Analyze this song or set manual timing before playing.");
            j.open = false;
            await startSession(world, { mode: "library", song: { slotId: `quick-${crypto.randomUUID()}`,
                trackId: t.id, audioHash: t.contentHash, chartId: c.id, title: t.title, artist: t.artist,
                duration: c.manifest.duration, timing: c.timing } });
        },
        analyze: id => library().retryAnalysis(id), manual: (id, bpm, offset) => library().manualTiming(id, bpm, offset),
        rename: (id, title, artist) => library().renameTrack(id, title, artist),
        remove: id => library().deleteTrack(id, { removePlaylistEntries: true }), relink: (id, file) => library().relink(id, file),
        savePlaylist: async (id, name, tracks) => (await library().savePlaylist({ id, name,
            slots: tracks.map(trackId => ({ id: `slot-${crypto.randomUUID()}`, trackId })) })).id,
        deletePlaylist: id => library().deletePlaylist(id), startPlaylist: id => startCampaign(world, id),
        continue: () => continueCampaign(world),
        arena: async id => {
            if (!isEncounterId(id) || !j.current || j.busy) return;
            await commitRun(world, selectRunArena(j.current, id), () => showRunBoundary(world));
        },
        abandon: async () => {
            await ownRun(world);
            if (!j.active) return;
            await commitRun(world, abandonRun(j.active), async () => { quitSession(world, true); j.current = undefined; j.open = true; await j.store!.release(); });
        },
        persist: () => library().requestPersistence(),
        export: async () => {
            const json = await library().exportRecovery();
            const url = URL.createObjectURL(new Blob([typeof json === "string" ? json : JSON.stringify(json, null, 2)], { type: "application/json" }));
            const a = document.createElement("a"); a.href = url; a.download = `beatshooter-recovery-${new Date().toISOString().slice(0, 10)}.json`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        recover: async file => { await library().importRecovery(await file.text()); j.active = await j.store!.activeRecord(); },
        retrySave: async () => { await j.retrySave?.(); },
        reloadSave: async () => {
            j.retrySave = undefined; j.error = undefined;
            quitSession(world);
            await j.store?.release();
            j.active = await j.store?.activeRecord();
            j.open = true;
            j.notice = "Reloaded the last committed checkpoint. Uncommitted progress was discarded.";
        },
    });
    void initializeJourney(world);
    return () => { j.unsubscribe?.(); j.library?.dispose(); void j.store?.release(); j.ui?.dispose(); };
}
