import {
    Body, BodyType, Camera, component, GlobalTransform, MeshInstance, MeshMaterial,
    Resolution, setLinearVelocity, Sound, StandardPhysicsPlugin, StepPhysicsSystem,
    Transform, type Plugin, type Resource, type System, type World,
} from "@dylanebert/shallot";
import { AudioOutput, play, registerClip } from "@dylanebert/shallot/audio";
import { Shape, ShapeKind } from "@dylanebert/shallot/physics";
import { Arena, enemyMaterial } from "../arena";
import { advanceCombat, createCombat, onCombatBeat, type CombatState } from "../combat";
import { enemyVelocity } from "../enemies";
import { PLANAR_LOCKS, PlayerState, resetPlayer, SnapshotPlayer } from "../player";
import { MusicTransport, type ScheduledBeat } from "../rhythm/transport";
import { beatAtPosition } from "../rhythm/timeline";
import {
    loadPreferences, resetPreferences, savePreferences, updateBest, validateSettings,
    type Preferences, type Settings,
} from "../settings";
import { createPracticeTrack, DEMO_TRACK, TrackLoader, type LoadedTrack, type TrackManifest } from "../tracks";
import { mountUI, type UIView } from "../ui";
import { analyzeAudio } from "../analysis";
import { createAnalyzedChart } from "../analysis/chart";
import type { BeatAnalysis } from "../analysis/types";
import { publishVisualEvents, VisualEvents } from "../music-visuals/events";
import { DashState } from "../dash/state";
import { chooseUpgrade, createUpgradeState, prepareUpgradeChoices } from "../upgrades";
import { advanceSectionDifficulty } from "../combat/difficulty";
import { shieldReady } from "../combat/specials";

export type Phase = "menu" | "loading" | "starting" | "playing" | "paused" | "results";
export const isRunningPhase = (phase: Phase) => phase === "playing";
export const isArenaPhase = (phase: Phase) => isRunningPhase(phase) || phase === "paused" || phase === "starting";
export type Selection = { mode: "demo" } | { mode: "dojo"; bpm: number } | { mode: "local"; file: File; bpm: number; offset: number; useAnalysis?: boolean };
export const SessionEntity = component("Beatshooter/SessionEntity", {});
interface SessionData {
    phase: Phase; selection: Selection; track: TrackManifest; loaded?: LoadedTrack;
    transport?: MusicTransport; loader?: TrackLoader; preferences: Preferences;
    combat: CombatState; enemyBodies: Map<number, number>; pending: ScheduledBeat[];
    generation: number; loadToken: number; position: number; visualPosition: number;
    enemyMotionPosition: number;
    completePending: boolean; loadingLostFocus: boolean; error?: string; pauseReason?: string; result?: "complete" | "defeat";
    ui?: ReturnType<typeof mountUI>; diagnostics: boolean; shotClip: number; hitClip: number;
    preview: boolean; previewLoading: boolean; previewLoaded?: LoadedTrack; previewUntil: number; fps: number;
    analysis?: UIView["analysis"]; analysisController?: AbortController;
    analyzedFile?: File; analyzedTrack?: BeatAnalysis;
    startBusy: boolean;
}
export const Session: Resource<SessionData> = {
    create: () => ({
        phase: "menu", selection: { mode: "demo" }, track: DEMO_TRACK,
        preferences: loadPreferences(), combat: createCombat(2026), enemyBodies: new Map(),
        pending: [], generation: 0, loadToken: 0, position: 0, visualPosition: 0,
        enemyMotionPosition: -Infinity,
        completePending: false, loadingLostFocus: false, diagnostics: false, shotClip: -1, hitClip: -1,
        preview: false, previewLoading: false, previewUntil: 0, fps: 60,
        startBusy: false,
    }),
};

function stopEffects(world: World): void {
    for (const eid of [...world.query([Sound])]) world.destroy(eid);
}

function clearSession(world: World): void {
    const session = world.resource(Session);
    session.transport?.stop();
    world.setTimeScale(1);
    session.startBusy = false;
    session.pending.length = 0;
    world.resource(VisualEvents).pending.length = 0;
    session.completePending = false;
    session.enemyBodies.clear();
    for (const eid of [...world.query([SessionEntity])]) world.destroy(eid);
    stopEffects(world);
    session.combat = createCombat(2026);
    session.position = session.visualPosition = 0;
    session.enemyMotionPosition = -Infinity;
    session.generation++;
    const dash = world.resource(DashState);
    dash.controller.reset();
    dash.held = false;
    resetPlayer(world);
}

function audio(world: World): { transport: MusicTransport; loader: TrackLoader; context: AudioContext } {
    const session = world.resource(Session), output = world.resource(AudioOutput);
    if (!output.context || !output.bus) {
        throw new Error("Audio output is unavailable. Enable sound in your browser and reload this page.");
    }
    session.transport ??= new MusicTransport(output.context, output.bus);
    session.loader ??= new TrackLoader(output.context);
    applySettings(world);
    return { transport: session.transport, loader: session.loader, context: output.context };
}

export function applySettings(world: World, patch?: Partial<Settings>): void {
    const session = world.resource(Session);
    if (patch) {
        session.preferences.settings = validateSettings({ ...session.preferences.settings, ...patch });
        savePreferences(session.preferences);
    }
    const settings = session.preferences.settings;
    session.transport?.setVolumes({ master: settings.masterVolume, music: settings.musicVolume, effects: settings.effectsVolume });
    session.transport?.setVisualOffset(settings.timingOffsetMs);
    // Use the retained accepted position while paused, including calibration
    // edits. The next observation uses the same offset on the live music clock.
    session.visualPosition = session.position + settings.timingOffsetMs / 1000;
    const camera = world.resource(Arena).camera;
    if (camera >= 0) {
        world.storage(Camera).antialias.set(camera, settings.graphics === "high" ? 1 : 0);
        if (settings.graphics === "low") {
            if (!world.has(camera, Resolution)) world.add(camera, Resolution, { height: 540 });
        } else if (world.has(camera, Resolution)) world.remove(camera, Resolution);
    }
    renderUI(world);
}

export function stopPreview(world: World): void {
    const session = world.resource(Session);
    if (session.previewLoading) {
        session.loadToken++;
        session.loader?.cancel();
        session.previewLoading = false;
    }
    if (!session.preview) return;
    session.preview = false;
    session.transport?.stop();
    session.previewLoaded?.dispose();
    session.previewLoaded = undefined;
}

export function cancelAnalysis(world: World): void {
    const session = world.resource(Session);
    if (!session.analysisController) return;
    session.analysisController.abort();
    session.analysisController = undefined;
    session.loader?.cancel();
    session.analysis = { state: "idle", message: "Analysis cancelled. You can retry or use manual BPM." };
    renderUI(world);
}

export function clearAnalysis(world: World): void {
    cancelAnalysis(world);
    const session = world.resource(Session);
    session.analyzedFile = undefined;
    session.analyzedTrack = undefined;
    session.analysis = undefined;
    session.loader?.clearLocalCache();
    if (session.phase === "menu" && !session.preview) session.transport?.unload();
    renderUI(world);
}

export async function analyzeLocal(world: World, file: File): Promise<void> {
    const session = world.resource(Session);
    if (session.phase !== "menu") return;
    stopPreview(world);
    clearAnalysis(world);
    const controller = new AbortController();
    session.analysisController = controller;
    session.analysis = { state: "running", message: "Decoding your track…", fileName: file.name };
    renderUI(world);
    try {
        const { loader } = audio(world);
        const prepared = await loader.prepareLocal(file);
        if (controller.signal.aborted) return;
        const analysis = await analyzeAudio(prepared.buffer, {
            signal: controller.signal,
            onProgress(progress) {
                if (controller.signal.aborted) return;
                const percent = progress.total > 0
                    ? ` ${Math.round(progress.completed / progress.total * 100)}%` : "";
                session.analysis = {
                    state: "running", fileName: file.name,
                    message: `${progress.stage}${percent}`,
                    progress: progress.total > 0 ? progress.completed / progress.total : 0,
                };
                renderUI(world);
            },
        });
        if (controller.signal.aborted) return;
        const chart = createAnalyzedChart(analysis);
        session.analyzedFile = file;
        session.analyzedTrack = analysis;
        session.analysis = {
            state: "ready", fileName: file.name, message: "Detected beats ready. Preview the timing before you play.",
            bpm: chart.bpm, beatCount: chart.summary.beatCount, downbeatCount: chart.summary.downbeatCount,
            duration: analysis.duration, elapsedMs: analysis.elapsedMs,
            warnings: [...chart.warnings, ...(analysis.sectionWarning ? [analysis.sectionWarning] : [])],
            barSource: chart.barSource, structure: analysis.structure,
        };
    } catch (error) {
        if (controller.signal.aborted) return;
        session.analysis = {
            state: "error", fileName: file.name,
            message: error instanceof Error ? error.message : "Analysis failed. Retry or use manual BPM.",
        };
    } finally {
        if (session.analysisController === controller) {
            session.analysisController = undefined;
            renderUI(world);
        }
    }
}

function selectedAnalysis(session: SessionData, file: File, useAnalysis = false): BeatAnalysis | undefined {
    if (!useAnalysis) return undefined;
    if (session.analyzedFile !== file || !session.analyzedTrack) {
        throw new Error("Analyze the selected file before using detected beats, or choose Manual BPM.");
    }
    return session.analyzedTrack;
}

export async function startSession(world: World, selection: Selection): Promise<void> {
    const session = world.resource(Session);
    cancelAnalysis(world);
    stopPreview(world);
    const token = ++session.loadToken;
    clearSession(world);
    session.loader?.cancel();
    session.loaded?.dispose();
    session.loaded = undefined;
    session.selection = selection;
    session.phase = "loading";
    session.loadingLostFocus = false;
    session.error = undefined;
    session.result = undefined;
    world.resource(PlayerState).enabled = false;
    world.pause();
    renderUI(world);
    try {
        const { loader, context } = audio(world);
        // Called before the first await, preserving the explicit button/key gesture.
        await context.resume();
        if (token !== session.loadToken) return;
        const loaded = selection.mode === "demo" ? await loader.load(DEMO_TRACK)
            : selection.mode === "local" ? await loader.loadLocal(selection.file, selection.bpm, selection.offset,
                selectedAnalysis(session, selection.file, selection.useAnalysis))
            : undefined;
        if (token !== session.loadToken) { loaded?.dispose(); return; }
        session.loaded = loaded;
        session.track = loaded?.manifest ?? createPracticeTrack(selection.mode === "dojo" ? selection.bpm : 120);
        if (selection.mode === "local") {
            session.preferences.lastLocal = {
                name: selection.file.name, bpm: session.track.bpm, offset: session.track.firstBeatOffset,
            };
            savePreferences(session.preferences);
        }
        // The free level-one choice is separate from XP-earned levels. Keep the
        // transport stopped so the first beat and count-in wait for the player.
        // Seed offers once per new run, independently of the combat random stream.
        session.combat.upgrades = createUpgradeState(crypto.getRandomValues(new Uint32Array(1))[0]!);
        session.combat.upgrades.pending = 1;
        prepareUpgradeChoices(session.combat);
        session.phase = "starting";
    } catch (error) {
        if (token !== session.loadToken) return;
        session.transport?.stop();
        session.loaded?.dispose();
        session.loaded = undefined;
        session.phase = "menu";
        session.error = error instanceof Error ? error.message : "The track could not be loaded. Please choose it again.";
    }
    renderUI(world);
}

export function pauseSession(world: World, reason = "Paused by you"): void {
    const session = world.resource(Session);
    if (session.phase === "starting" && reason === "Window lost focus") session.loadingLostFocus = true;
    if (!isRunningPhase(session.phase)) return;
    session.transport?.pause(reason === "Window lost focus" ? "hidden" : "user");
    // Observation already advanced the transport cursor. A high-refresh frame
    // may not have reached its next fixed step yet, so commit accepted commands
    // before freezing rather than losing that beat until the next one arrives.
    if (session.pending.length) PrepareCombat.update!(world);
    session.phase = "paused";
    session.pauseReason = reason;
    world.resource(PlayerState).enabled = false;
    world.resource(PlayerState).keys.clear();
    stopEffects(world);
    world.pause();
    world.setTimeScale(1);
    renderUI(world);
}

export async function resumeSession(world: World): Promise<void> {
    const session = world.resource(Session);
    if (session.phase === "starting" && session.combat.upgrades.pending === 0) {
        await startPlayback(world);
        return;
    }
    if (session.phase !== "paused") return;
    const token = session.loadToken;
    try {
        const { context, transport } = audio(world);
        await context.resume();
        if (token !== session.loadToken || session.phase !== "paused") return;
        await transport.resume();
        if (token !== session.loadToken || session.phase !== "paused") return;
        session.phase = "playing";
        session.error = undefined;
        world.resource(PlayerState).enabled = true;
        world.setTimeScale(1);
        world.resume();
    } catch (error) {
        if (token !== session.loadToken || session.phase !== "paused") return;
        session.error = error instanceof Error ? error.message : "Allow audio, then try Resume again.";
    }
    renderUI(world);
}

async function startPlayback(world: World): Promise<void> {
    const s = world.resource(Session);
    if (s.phase !== "starting" || s.startBusy || s.combat.upgrades.pending > 0) return;
    const token = s.loadToken;
    s.startBusy = true;
    s.loadingLostFocus = false;
    s.error = undefined;
    renderUI(world);
    try {
        const { transport, context } = audio(world);
        await context.resume();
        if (token !== s.loadToken || s.phase !== "starting") return;
        if (document.hidden || s.loadingLostFocus) throw new Error("Return to this window, then start your run.");
        await transport.start({ ...s.track, buffer: s.loaded?.buffer, metronome: s.selection.mode === "dojo" });
        if (token !== s.loadToken || s.phase !== "starting") return;
        s.position = transport.position;
        s.visualPosition = transport.visualPosition;
        s.phase = "playing";
        world.resource(PlayerState).enabled = true;
        world.resume();
        if (s.loadingLostFocus || document.hidden) pauseSession(world, "Window lost focus");
    } catch (error) {
        if (token !== s.loadToken) return;
        s.transport?.stop();
        s.error = error instanceof Error ? error.message : "Allow audio, then try starting again.";
    } finally {
        if (token === s.loadToken) { s.startBusy = false; renderUI(world); }
    }
}

/** Apply immediately; the offer's level prevents a stale card spending a queued choice. */
export function selectUpgrade(world: World, id: string, offeredLevel: number): boolean {
    const s = world.resource(Session);
    if ((s.phase !== "playing" && s.phase !== "starting") || s.startBusy || s.completePending
        || offeredLevel !== s.combat.upgrades.offeredLevel) return false;
    const choice = s.combat.upgrades.choices.find(item => item.id === id);
    if (!choice || !chooseUpgrade(s.combat, choice.id, s.phase === "starting" ? 0 : s.transport?.position ?? s.position)) return false;
    if (s.phase === "starting") { void startPlayback(world); return true; }
    prepareUpgradeChoices(s.combat);
    renderUI(world);
    return true;
}

export function quitSession(world: World): void {
    const session = world.resource(Session);
    cancelAnalysis(world);
    session.loadToken++;
    session.loader?.cancel();
    stopPreview(world);
    clearSession(world);
    session.loaded?.dispose();
    session.loaded = undefined;
    session.selection = { mode: "demo" };
    session.track = DEMO_TRACK;
    session.phase = "menu";
    session.error = undefined;
    world.resource(PlayerState).enabled = false;
    world.pause();
    renderUI(world);
}

function finishSession(world: World, result: "complete" | "defeat"): void {
    const session = world.resource(Session);
    if (!isRunningPhase(session.phase)) return;
    session.transport?.stop();
    session.pending.length = 0;
    session.result = result;
    session.phase = "results";
    world.setTimeScale(1);
    session.preferences = updateBest(session.preferences, session.track.id, session.combat.score);
    savePreferences(session.preferences);
    world.resource(PlayerState).enabled = false;
    stopEffects(world);
    world.pause();
    renderUI(world);
}

async function previewLocal(
    world: World, file: File, bpm: number, offset: number, useAnalysis = false,
    section: "start" | "middle" | "end" | "full" = "start",
): Promise<void> {
    const session = world.resource(Session);
    if (session.phase !== "menu") return;
    stopPreview(world);
    const token = ++session.loadToken;
    session.previewLoading = true;
    session.error = undefined;
    try {
        const { context, loader, transport } = audio(world);
        await context.resume();
        if (token !== session.loadToken) return;
        const loaded = await loader.loadLocal(file, bpm, offset, selectedAnalysis(session, file, useAnalysis));
        if (token !== session.loadToken) { loaded.dispose(); return; }
        session.previewLoading = false;
        session.previewLoaded = loaded;
        session.preview = true;
        await transport.start({ ...loaded.manifest, buffer: loaded.buffer, metronome: true, countInBeats: 0 });
        if (token !== session.loadToken) return;
        // Include the first rhythmic passage when a track has a quiet introduction.
        const duration = loaded.manifest.duration;
        const previewStart = section === "middle" ? Math.max(0, duration / 2 - 6)
            : section === "end" ? Math.max(0, duration - 12)
            : section === "full" ? 0
            : useAnalysis ? Math.max(0, loaded.manifest.firstBeatOffset - 1) : 0;
        if (previewStart > 0) transport.seek(previewStart);
        session.previewUntil = section === "full" ? duration : Math.min(previewStart + 12, duration);
    } catch (error) {
        if (token !== session.loadToken) return;
        session.previewLoading = false;
        stopPreview(world);
        session.error = error instanceof Error ? error.message : "Preview failed; please reselect the file.";
    }
    renderUI(world);
}

export function mountGameUI(container: HTMLElement, world: World): () => void {
    const session = world.resource(Session);
    session.ui = mountUI({
        startDemo: () => void startSession(world, { mode: "demo" }),
        startDojo: bpm => void startSession(world, { mode: "dojo", bpm }),
        startLocal: (file, bpm, offset, useAnalysis) => startSession(world, { mode: "local", file, bpm, offset, useAnalysis }),
        previewLocal: (file, bpm, offset, useAnalysis, section) => previewLocal(world, file, bpm, offset, useAnalysis, section),
        analyzeLocal: file => analyzeLocal(world, file),
        cancelAnalysis: () => cancelAnalysis(world),
        clearAnalysis: () => clearAnalysis(world),
        stopPreview: () => { ++session.loadToken; session.loader?.cancel(); stopPreview(world); },
        pause: () => pauseSession(world),
        resume: () => void resumeSession(world),
        retry: () => void startSession(world, session.selection),
        quit: () => quitSession(world),
        resetDojo: () => void startSession(world, session.selection),
        chooseUpgrade: (id, level) => selectUpgrade(world, id, level),
        updateSettings: patch => applySettings(world, patch),
        resetSettings: () => { session.preferences = resetPreferences(); applySettings(world); },
    }, container);
    renderUI(world);
    return () => { session.ui?.dispose(); session.ui = undefined; };
}

export function renderUI(world: World): void {
    const s = world.resource(Session);
    if (!s.ui) return;
    const currentBeat = beatAtPosition(s.track.beats, s.visualPosition);
    let beatsPerBar = s.track.beatsPerBar;
    if (currentBeat) {
        let end = currentBeat.index;
        while (s.track.beats[end + 1]?.bar === currentBeat.bar) end++;
        beatsPerBar = s.track.beats[end]!.beatInBar + 1;
    }
    const view: UIView = {
        phase: s.phase, mode: s.selection.mode, settings: s.preferences.settings,
        title: s.track.title, credit: s.track.artist, duration: s.track.duration, bpm: s.track.bpm,
        score: s.combat.score, kills: s.combat.kills, health: s.combat.health,
        level: s.combat.experience.level, xp: s.combat.experience.xp,
        requiredXp: s.combat.experience.requiredXp, totalXp: s.combat.experience.totalXp,
        maxHealth: s.combat.playerStats.effective.maxHealth, position: s.position,
        shield: s.combat.playerStats.effective.regenerativeShield > 0 ? {
            ready: shieldReady(s.combat, s.position),
            remaining: Math.max(0, s.combat.shieldRechargeAt - s.position),
        } : undefined,
        generation: s.generation, beats: s.track.beats,
        structure: s.loaded?.structure,
        previewPosition: s.preview ? s.transport?.position : 0,
        upgrade: s.phase === "starting" || (s.phase === "playing" && s.combat.upgrades.choices.length > 0) ? {
            choices: s.combat.upgrades.choices,
            level: s.combat.upgrades.offeredLevel,
            pending: s.combat.upgrades.pending,
            busy: s.startBusy,
        } : undefined,
        beat: currentBeat?.index ?? -1, beatInBar: currentBeat?.beatInBar ?? -1,
        beatsPerBar, downbeat: currentBeat?.downbeat ?? false, analysis: s.analysis,
        dashState: world.resource(DashState).controller.status(s.position),
        dashBeatInBar: world.resource(DashState).controller.timing.candidate(s.position)?.beatInBar,
        bar: Math.max(0, s.combat.lastBarIndex), result: s.result,
        bestScore: s.preferences.bestScores[s.track.id] ?? 0,
        error: s.error, pauseReason: s.pauseReason,
        previewing: s.preview || s.previewLoading, lastLocal: s.preferences.lastLocal,
        demo: { title: DEMO_TRACK.title, credit: DEMO_TRACK.artist, bpm: DEMO_TRACK.bpm, duration: DEMO_TRACK.duration, bestScore: s.preferences.bestScores[DEMO_TRACK.id] ?? 0 },
        diagnostics: s.diagnostics
            ? `${Math.round(s.fps)} FPS · ${s.combat.enemies.length} enemies · ${s.combat.projectiles.length} shots · ${s.combat.effects.length} effects · tick ${world.time.fixedTick}`
            : undefined,
    };
    s.ui.render(view);
}

export const ObserveMusic: System = {
    name: "Beatshooter/ObserveMusic", group: "setup",
    update(world) {
        const s = world.resource(Session);
        if (!s.transport || (!isRunningPhase(s.phase) && !s.preview)) return;
        const observation = s.transport.observe();
        if (s.preview) {
            if (observation.completed || observation.pausedReason || observation.position >= s.previewUntil) stopPreview(world);
            return;
        }
        if (observation.pausedReason) {
            pauseSession(world, observation.pausedReason === "stall" ? "Playback paused after a long frame. Resume when ready." : "Audio was suspended. Resume to continue.");
            return;
        }
        s.position = observation.position;
        s.visualPosition = observation.visualPosition;
        s.pending.push(...observation.beats);
        s.completePending ||= observation.completed;
    },
};

export const PrepareCombat: System = {
    name: "Beatshooter/PrepareCombat", group: "fixed",
    before: StandardPhysicsPlugin.systems?.filter(system => system.group === "fixed"),
    update(world) {
        const s = world.resource(Session), p = world.resource(PlayerState);
        if (!isRunningPhase(s.phase)) return;
        advanceSectionDifficulty(s.combat, (s.loaded?.structure ?? s.track.structure)?.sections, s.position);
        for (const beat of s.pending.splice(0)) {
            const events = onCombatBeat(s.combat, {
                index: beat.index, barIndex: beat.bar, isDownbeat: beat.downbeat,
                time: beat.time, nextBeatTime: s.track.beats[beat.index + 1]?.time ?? null,
            }, p.position, p.aim);
            publishVisualEvents(world, events, s.position, s.visualPosition, s.generation, beat.time);
            const settings = s.preferences.settings;
            play(world, s.shotClip, { volume: settings.masterVolume * settings.effectsVolume * 0.35 });
        }
        for (const enemy of s.combat.enemies) {
            let eid = s.enemyBodies.get(enemy.id);
            // Raw transport time keeps movement on audible beats, independent
            // of visual calibration, frame rate and effects preferences.
            const velocity = enemyVelocity(enemy, p.position, s.combat,
                s.position, world.time.deltaTime, s.enemyMotionPosition);
            if (eid === undefined) {
                eid = world.create();
                s.enemyBodies.set(enemy.id, eid);
                world.add(eid, SessionEntity);
                world.add(eid, Transform, { translation: [enemy.x, 0.55, enemy.z], rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] });
                world.add(eid, Body, { type: BodyType.Dynamic, motionLocks: PLANAR_LOCKS, enableSleep: 0, gravityScale: 0, linearVelocity: [velocity.x, 0, velocity.z] });
                world.add(eid, Shape, { kind: ShapeKind.Sphere, radius: enemy.radius, friction: 0, filterCategoryLow: 2, filterMaskLow: 7, filterCategoryHigh: 0, filterMaskHigh: 0 });
                world.add(eid, MeshInstance);
                world.add(eid, MeshMaterial, enemyMaterial(world.resource(Arena), enemy.kind));
            }
            setLinearVelocity(world, eid, { x: velocity.x, y: 0, z: velocity.z });
        }
        // Extra fixed ticks at a held audio observation cannot replay the stride.
        s.enemyMotionPosition = s.position;
    },
};

export const ResolveCombat: System = {
    name: "Beatshooter/ResolveCombat", group: "fixed", after: [StepPhysicsSystem, SnapshotPlayer],
    update(world) {
        const s = world.resource(Session);
        if (!isRunningPhase(s.phase) || s.position < 0) return;
        const positions = new Map<number, { x: number; z: number }>();
        const pose = world.storage(GlobalTransform).translation;
        for (const [id, eid] of s.enemyBodies) positions.set(id, { x: pose.x.get(eid), z: pose.z.get(eid) });
        const player = world.resource(PlayerState);
        const result = advanceCombat(s.combat, world.time.deltaTime, player.position, positions, player.previous, s.position);
        publishVisualEvents(world, result.events, s.position, s.visualPosition, s.generation);
        const live = new Set(s.combat.enemies.map(enemy => enemy.id));
        for (const [id, eid] of s.enemyBodies) {
            if (!live.has(id)) { world.destroy(eid); s.enemyBodies.delete(id); }
        }
        if (result.killedIds.length || result.playerDamaged) {
            const settings = s.preferences.settings;
            play(world, s.hitClip, { volume: settings.masterVolume * settings.effectsVolume * 0.5 });
        }
        if (result.defeated) finishSession(world, "defeat");
        else if (s.completePending) finishSession(world, "complete");
        else if (s.combat.upgrades.pending > 0) prepareUpgradeChoices(s.combat);
    },
};

export const SessionPlugin: Plugin = {
    name: "Beatshooter/Session", deterministic: false, recovery: "stateless",
    components: [SessionEntity],
    initialize(world) {
        const s = world.resource(Session);
        const pcm = (frequency: number) => {
            const data = new Float32Array(4800);
            for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 48000 * Math.PI * 2 * frequency * (1 - i / data.length * 0.5)) * Math.exp(-i / 750) * 0.35;
            return data;
        };
        s.shotClip = registerClip(world, pcm(800), 48000, "Original pulse shot");
        s.hitClip = registerClip(world, pcm(180), 48000, "Original impact");
        world.pause();
        if (typeof window !== "undefined") {
            const loseFocus = () => {
                if (s.phase === "loading") s.loadingLostFocus = true;
                pauseSession(world, "Window lost focus");
                stopPreview(world);
            };
            window.addEventListener("blur", loseFocus, { signal: world.signal });
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) loseFocus();
            }, { signal: world.signal });
            window.addEventListener("keydown", event => {
                if ((event.target as HTMLElement)?.matches("input,select,textarea") || event.repeat) return;
                if (event.code === "Escape") {
                    if (s.phase === "playing") pauseSession(world);
                    else if (s.phase === "paused") void resumeSession(world);
                } else if (event.code === "KeyR" && s.selection.mode === "dojo" && (s.phase === "playing" || s.phase === "paused")) {
                    void startSession(world, s.selection);
                } else if (event.code === "F3") { event.preventDefault(); s.diagnostics = !s.diagnostics; renderUI(world); }
            }, { signal: world.signal });
        }
        world.onDispose(() => {
            s.loadToken++;
            const analysisController = s.analysisController;
            s.analysisController = undefined;
            analysisController?.abort();
            s.transport?.dispose();
            s.loader?.dispose();
            s.ui?.dispose();
        });
    },
    systems: [ObserveMusic, PrepareCombat, ResolveCombat, {
        name: "Beatshooter/HUD", group: "simulation",
        update(world) {
            const s = world.resource(Session);
            if (world.time.rawDeltaTime > 0) s.fps += (1 / world.time.rawDeltaTime - s.fps) * 0.04;
            renderUI(world);
        },
    }],
};
