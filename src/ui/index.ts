import type { LocalTrackMetadata, Settings } from "../settings";
import { DEMO_TRACK } from "../tracks";
import type { UpgradeChoice, UpgradeTextPart } from "../upgrades";
import type { SectionAnalysis } from "../analysis/sections";
import type { Beat } from "../rhythm/timeline";
import { UpgradeFeedback, sampleMenuUpgradeFeedback } from "./upgrade-feedback";
import { mountTrackPlayer } from "./track-player";
import "./style.css";
import "./track-player.css";
import "./menus.css";

export interface UIActions {
    startDemo(): void | Promise<unknown>;
    startDojo(bpm: number): void | Promise<unknown>;
    startLocal(file: File, bpm: number, offsetSeconds: number, useAnalysis?: boolean): void | Promise<unknown>;
    previewLocal(file: File, bpm: number, offsetSeconds: number, useAnalysis?: boolean, previewSection?: "start" | "middle" | "end" | "full"): void | Promise<unknown>;
    analyzeLocal(file: File): Promise<void>;
    cancelAnalysis(): void;
    clearAnalysis(): void;
    stopPreview(): void;
    pause(): void;
    resume(): void | Promise<unknown>;
    retry(): void | Promise<unknown>;
    quit(): void;
    resetDojo(): void;
    updateSettings(patch: Partial<Settings>): void;
    resetSettings(): void;
    chooseUpgrade(id: string, offeredLevel: number): boolean;
}

export interface UIView {
    phase: "menu" | "loading" | "starting" | "playing" | "paused" | "results";
    mode?: "demo" | "dojo" | "local";
    settings: Settings;
    title?: string;
    credit?: string;
    duration?: number;
    bpm?: number;
    score?: number;
    kills?: number;
    health?: number;
    maxHealth?: number;
    shield?: { ready: boolean; remaining: number };
    level?: number;
    xp?: number;
    requiredXp?: number;
    totalXp?: number;
    upgrade?: {
        choices: readonly UpgradeChoice[];
        level: number;
        pending: number;
        busy?: boolean;
    };
    position?: number;
    generation?: number;
    beats?: readonly Beat[];
    structure?: SectionAnalysis;
    previewPosition?: number;
    beat?: number;
    bar?: number;
    beatInBar?: number;
    beatsPerBar?: number;
    downbeat?: boolean;
    dashState?: "ready" | "used" | "waiting" | "dashing";
    dashBeatInBar?: number;
    result?: "complete" | "defeat";
    bestScore?: number;
    error?: string;
    pauseReason?: string;
    diagnostics?: string;
    loadingMessage?: string;
    previewing?: boolean;
    lastLocal?: LocalTrackMetadata;
    analysis?: {
        state: "idle" | "running" | "ready" | "error";
        message: string;
        progress?: number;
        fileName?: string;
        bpm?: number;
        beatCount?: number;
        downbeatCount?: number;
        duration?: number;
        elapsedMs?: number;
        warnings?: string[];
        barSource?: "detected" | "synthetic";
        structure?: SectionAnalysis;
    };
    demo?: { title: string; credit: string; duration: number; bpm: number; bestScore?: number };
}

export interface GameUI {
    render(view: UIView): void;
    dispose(): void;
}

const icons = {
    play: '<path d="m8 5 11 7-11 7Z"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    volume: '<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6"/>',
    cross: '<path d="m6 6 12 12M6 18 18 6"/>',
    pause: '<path d="M8 5v14m8-14v14"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    reset: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
    damage: '<path d="m13 2-8 12h6l-1 8 9-13h-7l1-7Z"/>',
    health: '<path d="m12 3 8 4v6c0 4-8 8-8 8s-8-4-8-8V7l8-4Z"/><path d="M8 12h8m-4-4v8"/>',
    regeneration: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6M8 12h8m-4-4v8"/>',
    projectiles: '<path d="M12 21V3m-3 3 3-3 3 3M8 20 3 8m0 4V8h4m9 12 5-12m0 4V8h-4"/>',
    barrage: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4M4 4l3 3m10 10 3 3M4 20l3-3M17 7l3-3"/>',
    critical: '<path d="m12 2 2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2ZM20 18v4m-2-2h4"/>',
    bounce: '<path d="M3 20 11 4l8 16m-5-3 5 3 2-5M4 3h15"/>',
    pickup: '<path d="M7 4v8a5 5 0 0 0 10 0V4M7 8h3V4H7m10 4h-3V4h3M3 12H1m22 0h-2M4 18l-2 2m18-2 2 2"/>',
    dash: '<path d="m10 5 8 7-8 7M3 8h5M1 12h7M3 16h5"/>',
};

function icon(name: keyof typeof icons): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function clock(seconds: number): string {
    const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function count(value: number | undefined): string {
    return Math.max(0, Math.floor(value ?? 0)).toLocaleString("en-US");
}

function renderUpgradeText(element: HTMLElement, parts: readonly UpgradeTextPart[]): void {
    element.replaceChildren(...parts.map(part => {
        if (typeof part === "string") return document.createTextNode(part);
        const value = document.createElement("span");
        value.className = "bs-upgrade-value";
        value.dataset.statCategory = part.category;
        value.textContent = part.value;
        return value;
    }));
}

const template = `
    <div class="bs-menu" data-screen="menu">
        <header class="bs-topbar">
            <button class="bs-icon-button" data-action="settings" aria-label="Open settings" title="Settings">${icon("settings")}</button>
        </header>
        <main class="bs-menu-main">
            <section class="bs-intro">
                <h1>beatshooter</h1>
            </section>
            <section class="bs-session-select" aria-label="Play">
                <div class="bs-card-grid">
                    <article class="bs-track-card">
                        <div class="bs-track-art" aria-hidden="true">
                            <div class="bs-art-grid"></div><div class="bs-orbit bs-orbit-one"></div><div class="bs-orbit bs-orbit-two"></div>
                            <div class="bs-art-ship"><span></span></div><div class="bs-art-enemy bs-enemy-one"></div><div class="bs-art-enemy bs-enemy-two"></div>
                            <svg class="bs-waveform" viewBox="0 0 400 42" preserveAspectRatio="none"><path d="M0 21h9l3-9 4 18 4-26 4 34 4-19 4 9 4-7h12l4-14 4 25 4-17 4 13 4-7h15l4-19 4 38 4-27 4 18 4-10h15l4-10 4 19 4-29 4 37 4-17h13l4-15 4 29 4-23 4 15 4-6h17l4-18 4 36 4-25 4 14 4-7h17l4-12 4 24 4-32 4 39 4-19h14l4-9 4 18 4-26 4 34 4-17h17l4-15 4 30 4-25 4 19 4-9h14l4-20 4 40 4-27 4 15 4-7h18l4-11 4 23 4-19 4 12 4-5h20"/></svg>
                        </div>
                        <div class="bs-track-body">
                            <div class="bs-track-heading"><div><h3 data-value="demo-title">Neon Circuit</h3></div><span class="bs-pill">DEMO</span></div>
                            <p class="bs-credit" data-value="demo-credit">Beatshooter original</p>
                            <div class="bs-track-meta"><span><b data-value="demo-bpm">120</b> BPM</span><span data-value="demo-duration">1:04</span><span>4/4</span></div>
                            <button class="bs-button bs-button-primary bs-track-start" data-action="demo">${icon("play")}<span>Enter the arena</span>${icon("arrow")}</button>
                            <div class="bs-track-bottom"><span>BEST <b data-value="demo-best">—</b></span></div>
                        </div>
                    </article>
                    <div class="bs-side-cards">
                        <article class="bs-small-card bs-dojo-card">
                            <div class="bs-card-top"><span class="bs-small-icon">${icon("target")}</span></div>
                            <h3>Practice</h3>
                            <div class="bs-dojo-controls"><label for="bs-dojo-bpm">TEMPO <span class="bs-number-wrap"><input id="bs-dojo-bpm" name="dojo-bpm" type="number" min="20" max="300" step="1" value="120" aria-label="Dojo tempo in beats per minute"><span>BPM</span></span></label><button class="bs-button bs-button-outline" data-action="dojo">Practice ${icon("arrow")}</button></div>
                        </article>
                        <article class="bs-small-card bs-local-card">
                            <div class="bs-card-top"><span class="bs-small-icon">${icon("upload")}</span></div>
                            <h3>Your music</h3>
                            <button class="bs-button bs-button-quiet" data-action="import">Import local audio ${icon("arrow")}</button>
                        </article>
                    </div>
                </div>
            </section>
            <div class="bs-message" data-value="menu-error" role="alert" hidden></div>
            <section class="bs-controls" aria-label="How to play">
                <div><span class="bs-key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>Move</span></div>
                <div><span class="bs-mouse-icon" aria-hidden="true"></span><span>Aim</span></div>
                <div><span class="bs-beat-control" aria-hidden="true">∿</span><span>Auto-fire</span></div>
                <div><kbd>SPACE</kbd><span>Dash on beat · once per bar</span></div>
                <div><span class="bs-key-group"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span><span>Select upgrade</span></div>
                <div><kbd>ESC</kbd><span>Pause</span></div>
            </section>
        </main>
    </div>
    <div class="bs-hud" data-screen="hud" hidden>
        <div class="bs-hud-top">
            <div class="bs-vitals"><div class="bs-hud-label"><span>HULL INTEGRITY</span><strong data-value="health-label">100 / 100</strong></div><progress class="bs-health" max="100" value="100" aria-label="Player health"></progress><div class="bs-shield-status" hidden><span>${icon("health")} Shield</span><strong data-value="shield-status"></strong></div><p class="bs-track-playing"><span class="bs-live-dot"></span><span data-value="track-title">Neon Circuit</span><span class="bs-mode-label" data-value="mode-label">LIVE</span></p></div>
            <div class="bs-hud-score"><span class="bs-hud-label">SCORE</span><strong data-value="score">0</strong><span class="bs-kills"><b data-value="kills">0</b> ELIMINATED</span></div>
            <button class="bs-icon-button" data-action="pause" aria-label="Pause game" title="Pause (Escape)">${icon("pause")}</button>
        </div>
        <div class="bs-experience" role="group" aria-label="Player experience">
            <div class="bs-experience-label"><span class="bs-level-badge">LV <strong data-value="level">1</strong></span><span><b data-value="xp">0</b> / <b data-value="xp-required">30</b> XP</span></div>
            <progress class="bs-xp-progress" data-value="xp-progress" value="0" max="30" aria-label="Experience to next level"></progress>
        </div>
        <div class="bs-hud-bottom">
            <div class="bs-hud-beat" role="group" aria-label="Beat and dash timing">
                <span class="bs-count-in" data-value="count-in" hidden></span>
                <div class="bs-beat-dots" role="img" aria-label="Beat in bar"><i></i><i></i><i></i><i></i></div>
                <div class="bs-beat-meta">
                    <p><span data-value="bpm">120</span> BPM <span class="bs-hud-divider">/</span> BAR <span data-value="bar">01</span></p>
                    <div class="bs-dash-status" data-dash-state="waiting" title="Press Space within 150 ms of any beat. One dash per bar; resets at the next bar."><kbd>SPACE</kbd><span data-value="dash-status">Dash on beat</span></div>
                </div>
            </div>
            <div class="bs-run-progress"></div>
            <div class="bs-hud-hint"><span><kbd>WASD</kbd> MOVE</span><span>POINTER AIM</span><span data-value="auto-label">BEAT AUTO-FIRE</span><button class="bs-text-button" data-action="reset-dojo" hidden>${icon("reset")} RESET DOJO <kbd>R</kbd></button></div>
        </div>
        <pre class="bs-diagnostics" data-value="diagnostics" hidden></pre>
    </div>
    <div class="bs-cover" data-screen="loading" hidden><section class="bs-dialog bs-loading-dialog" role="status"><div class="bs-loading-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h2>Loading</h2><p data-value="loading-message">Loading audio…</p><button class="bs-button bs-button-quiet" data-action="quit">Cancel</button></section></div>
    <div class="bs-cover" data-screen="paused" hidden><section class="bs-dialog bs-pause-dialog" aria-labelledby="bs-pause-title"><h2 id="bs-pause-title">Paused</h2><p data-value="pause-reason"></p><div class="bs-message" data-value="session-error" role="alert" hidden></div><div class="bs-dialog-actions"><button class="bs-button bs-button-primary" data-action="resume">${icon("play")} Resume session</button><button class="bs-button bs-button-outline" data-action="settings">${icon("settings")} Settings</button><button class="bs-button bs-button-quiet" data-action="retry">${icon("reset")} Restart session</button><button class="bs-text-button" data-action="quit">Return to menu</button></div><p class="bs-dialog-footnote"><kbd>ESC</kbd> TO RESUME</p></section></div>
    <aside class="bs-upgrade-panel" data-upgrade-screen aria-labelledby="bs-upgrade-title" hidden>
        <div class="bs-upgrade-content">
        <header class="bs-upgrade-heading">
            <h2 id="bs-upgrade-title"><span data-value="upgrade-title">Upgrade</span> <small>LV <b data-value="upgrade-level">2</b></small></h2>
            <span class="bs-upgrade-pending" data-value="upgrade-pending" role="status" aria-live="polite" hidden></span>
        </header>
        <p class="bs-upgrade-intro" hidden>Choose an upgrade before the music starts. Later upgrades appear on the right while you keep playing. Press <kbd>1</kbd>, <kbd>2</kbd>, or <kbd>3</kbd> to choose. Extra upgrades queue until you select them.</p>
        <div class="bs-upgrade-cards" role="group" aria-label="Choose one of three upgrades"></div>
        <div class="bs-message" data-value="start-error" role="alert" hidden></div>
        <button class="bs-button bs-button-primary" data-action="start-ready" hidden>Start run</button>
        <button class="bs-text-button bs-start-quit" data-action="quit" hidden>Return to menu</button>
        </div>
    </aside>
    <div class="bs-cover" data-screen="results" hidden><section class="bs-dialog bs-results-dialog" aria-labelledby="bs-results-title"><h2 id="bs-results-title" data-value="result-title">Track complete</h2><div class="bs-result-score"><span>FINAL SCORE</span><strong data-value="result-score">0</strong><span data-value="best-label">PERSONAL BEST</span></div><div class="bs-result-stats"><div><strong data-value="result-kills">0</strong><span>ELIMINATED</span></div><div><strong data-value="result-time">0:00</strong><span>SURVIVED</span></div><div><strong data-value="result-best">0</strong><span>BEST SCORE</span></div></div><p class="bs-result-experience"><span>LEVEL <b data-value="result-level">1</b></span><span><b data-value="result-xp">0</b> TOTAL XP</span></p><div class="bs-dialog-actions"><button class="bs-button bs-button-primary" data-action="retry">${icon("reset")} Play again</button><button class="bs-button bs-button-outline" data-action="quit">Back to sessions ${icon("arrow")}</button></div><p class="bs-score-rule">100 points per elimination + 2 per beat survived.</p></section></div>
    <div class="bs-modal" data-modal="settings" hidden><section class="bs-dialog bs-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="bs-settings-title"><button class="bs-icon-button bs-dialog-close" data-action="close-settings" aria-label="Close settings">${icon("cross")}</button><h2 id="bs-settings-title">Settings</h2><div class="bs-settings-section"><h3>Audio mix</h3><label class="bs-slider-label" for="bs-master">Master <output for="bs-master" data-output="masterVolume">75%</output></label><input id="bs-master" data-setting="masterVolume" type="range" min="0" max="1" step="0.01" value=".75"><label class="bs-slider-label" for="bs-music">Music <output for="bs-music" data-output="musicVolume">80%</output></label><input id="bs-music" data-setting="musicVolume" type="range" min="0" max="1" step="0.01" value=".8"><label class="bs-slider-label" for="bs-effects">Effects <output for="bs-effects" data-output="effectsVolume">55%</output></label><input id="bs-effects" data-setting="effectsVolume" type="range" min="0" max="1" step="0.01" value=".55"></div><div class="bs-settings-section"><h3>Timing</h3><label class="bs-slider-label" for="bs-offset">Visual timing offset <output for="bs-offset" data-output="timingOffsetMs">0 ms</output></label><input id="bs-offset" data-setting="timingOffsetMs" type="range" min="-250" max="250" step="5" value="0"><p class="bs-setting-help">Positive: earlier pulse. Negative: later pulse. Audio and combat timestamps stay unchanged.</p></div><div class="bs-settings-section"><h3>Visuals</h3><label class="bs-select-label" for="bs-intensity">Visual effects<select id="bs-intensity" data-setting="effectsIntensity"><option value="off">Off</option><option value="calm">Calm</option><option value="standard">Standard</option></select></label><p class="bs-setting-help bs-visual-help">Calm reduces motion. Off disables effects.</p><label class="bs-select-label" for="bs-graphics">Graphics detail<select id="bs-graphics" data-setting="graphics"><option value="high">High</option><option value="low">Low</option></select></label><label class="bs-checkbox-label" for="bs-reduced"><span>Reduced flashes<small>Soften beat pulses and hit feedback.</small></span><input id="bs-reduced" data-setting="reducedFlash" type="checkbox"></label></div><div class="bs-settings-footer"><span>Saved automatically.</span><button class="bs-text-button" data-action="reset-settings">Reset settings</button></div></section></div>
    <div class="bs-modal" data-modal="import" hidden>
        <section class="bs-dialog bs-import-dialog" role="dialog" aria-modal="true" aria-labelledby="bs-import-title">
            <button class="bs-icon-button bs-dialog-close" data-action="close-import" aria-label="Close audio import">${icon("cross")}</button>
            <h2 id="bs-import-title">Import audio</h2>
            <p class="bs-local-reselect" data-value="local-reselect" hidden></p>
            <label class="bs-file-label" for="bs-audio-file">${icon("upload")}<span data-value="file-name">Choose an audio file</span><small>MP3, WAV, OGG, M4A, FLAC</small><input id="bs-audio-file" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac"></label>
            <section class="bs-analysis" aria-label="Beat analysis" data-analysis-state="idle">
                <div class="bs-analysis-actions">
                    <button class="bs-button bs-button-outline" data-action="analyze-local" disabled>${icon("target")}<span data-value="analyze-label">Analyze beats</span></button>
                    <button class="bs-text-button" data-action="cancel-analysis" hidden>Cancel analysis</button>
                </div>
                <div class="bs-analysis-status" role="status" aria-live="polite" aria-atomic="true">
                    <p data-value="analysis-message" hidden></p>
                    <p class="bs-analysis-summary" data-value="analysis-summary" hidden></p>
                </div>
                <progress class="bs-analysis-progress" aria-label="Finding beats" value="0" max="1" hidden></progress>
                <div class="bs-section-preview" hidden></div>
            </section>
            <details class="bs-timing-options" hidden>
                <summary>Timing</summary>
                <label class="bs-select-label bs-beat-source" for="bs-local-grid">Rhythm source<select id="bs-local-grid"><option value="detected">Detected beats</option><option value="manual">Manual BPM</option></select></label>
                <div class="bs-import-fields" hidden><label for="bs-local-bpm">TEMPO<input id="bs-local-bpm" type="number" min="20" max="300" step="1" value="120"><small>Beats per minute</small></label><label for="bs-local-offset">FIRST BEAT<input id="bs-local-offset" type="number" min="0" step=".01" value="0"><small>Seconds from the start</small></label></div>
            </details>
            <div class="bs-preview-section" hidden>
                <label class="bs-select-label" for="bs-preview-section">Preview section<select id="bs-preview-section"><option value="start">Start</option><option value="middle">Middle</option><option value="end">End</option><option value="full">Full track</option></select></label>
            </div>
            <div class="bs-message" data-value="import-error" role="alert" hidden></div>
            <div class="bs-dialog-actions"><button class="bs-button bs-button-outline" data-action="preview-local">${icon("volume")}<span data-value="preview-label">Preview with metronome</span></button><button class="bs-button bs-button-primary" data-action="start-local">${icon("play")} Play this track ${icon("arrow")}</button></div>
        </section>
    </div>
`;

/**
 * A world owns this UI and its event listeners. Rendering only changes text/attributes,
 * preserving keyboard focus, the selected local file and form values between ticks.
 */
export function mountUI(actions: UIActions, container: HTMLElement = document.body): GameUI {
    const root = document.createElement("div");
    root.className = "bs-ui";
    root.dataset.phase = "menu";
    root.innerHTML = template;
    container.append(root);
    const events = new AbortController();
    const trackPlayer = mountTrackPlayer(root.querySelector<HTMLElement>(".bs-run-progress")!);
    const previewElement = root.querySelector<HTMLElement>(".bs-section-preview")!;
    const sectionPreview = mountTrackPlayer(previewElement, "Section preview progress");
    let view: UIView | undefined;
    let modal: "settings" | "import" | undefined;
    let previousFocus: HTMLElement | null = null;
    let selectedFile: File | undefined;
    let previewing = false;
    let previousPhase: UIView["phase"] | undefined;
    let previousExternalError: string | undefined;
    let appliedLocalMetadata = false;
    let useAnalysis = false;
    let previousAnalysisState: NonNullable<UIView["analysis"]>["state"] = "idle";
    let upgradeKey = "";
    let upgradeActive = false;
    let selection: {
        id: string;
        offer: NonNullable<UIView["upgrade"]>;
        generation?: number;
        starting: boolean;
        feedback: UpgradeFeedback;
        menuAge: number;
        menuBeatDuration: number;
        lastFrame: number;
        focusedIndex: number;
    } | undefined;
    let selectionFrame = 0;
    const refs = new Map<string, HTMLElement>();
    for (const element of root.querySelectorAll<HTMLElement>("[data-value]")) {
        refs.set(element.dataset.value!, element);
    }
    const text = (key: string, value: string) => {
        const element = refs.get(key);
        if (element && element.textContent !== value) element.textContent = value;
    };
    const message = (key: string, value: string) => {
        text(key, value);
        const element = refs.get(key);
        if (element) element.hidden = !value;
    };
    const upgradePanel = root.querySelector<HTMLElement>(".bs-upgrade-panel")!;
    const upgradeCards = root.querySelector<HTMLElement>(".bs-upgrade-cards")!;
    const upgradeArt: Record<string, keyof typeof icons> = {
        damage: "damage", health: "health", regeneration: "regeneration",
        projectiles: "projectiles", barrage: "barrage",
        "crit-chance": "critical", "crit-damage": "critical", bounce: "bounce",
        "pickup-radius": "pickup", "dash-distance": "dash",
        "wall-bounce": "bounce", homing: "target", "regenerative-shield": "health",
    };
    const clearSelection = () => {
        selection = undefined;
        cancelAnimationFrame(selectionFrame);
        selectionFrame = 0;
        upgradeKey = "";
        upgradePanel.dataset.selectionState = "offered";
    };
    const animateSelection = (now: number) => {
        selectionFrame = 0;
        if (!selection || !view) return;
        // Only the pre-music choice uses a menu clock. Live confirmations are
        // sampled from accepted song time, including during pause and resume.
        if (selection.starting && view.phase !== "paused" && !document.hidden) {
            selection.menuAge += Math.max(0, now - selection.lastFrame) / 1000;
        }
        selection.lastFrame = now;
        renderUpgrade(view);
        if (selection) selectionFrame = requestAnimationFrame(animateSelection);
    };
    const selectUpgrade = (id: string, level: number) => {
        if (selection || modal || (view?.phase !== "playing" && view?.phase !== "starting") || view.upgrade?.busy || view.upgrade?.level !== level
            || !view.upgrade.choices.some(choice => choice.id === id)) return;
        selection = {
            id, offer: { ...view.upgrade, choices: [...view.upgrade.choices] },
            generation: view.generation, starting: view.phase === "starting",
            feedback: new UpgradeFeedback(view.beats ?? [], view.position ?? 0),
            menuAge: 0, menuBeatDuration: 60 / Math.max(20, view.bpm ?? 120),
            lastFrame: performance.now(),
            focusedIndex: [...upgradeCards.children].indexOf(document.activeElement as Element),
        };
        // A number-key choice can sit below the fold on short viewports.
        [...upgradeCards.querySelectorAll<HTMLButtonElement>("button")]
            .find(button => button.dataset.upgradeId === id)
            ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        // Retain the displayed offer before the synchronous session render
        // applies the stat and prepares any queued offer.
        if (!actions.chooseUpgrade(id, level)) clearSelection();
        renderUpgrade(view);
        if (selection?.starting && !selectionFrame) selectionFrame = requestAnimationFrame(animateSelection);
    };
    const renderUpgrade = (next: UIView) => {
        if (selection && (selection.generation !== next.generation ||
            !["starting", "playing", "paused"].includes(next.phase))) clearSelection();
        let feedback = selection
            ? selection.starting
                ? sampleMenuUpgradeFeedback(selection.menuAge, selection.menuBeatDuration)
                : selection.feedback.sample(next.position ?? 0)
            : undefined;
        let restoreFocus = -1;
        if (selection && (next.phase === "paused" || modal)) selection.focusedIndex = -1;
        if (feedback?.done) {
            // Disabled buttons lose focus. Restore an intentional card focus
            // into a queued offer, unless the player moved focus elsewhere.
            if (document.activeElement === document.body || upgradePanel.contains(document.activeElement)) {
                restoreFocus = selection?.focusedIndex ?? -1;
            }
            clearSelection();
            feedback = undefined;
        }
        const starting = next.phase === "starting" || (!!selection?.starting && next.phase === "playing");
        const active = (starting || (next.phase === "playing" && (!!selection || !!next.upgrade?.choices.length))) && !modal;
        upgradePanel.hidden = !active;
        upgradePanel.classList.toggle("bs-start-upgrade", starting);
        upgradePanel.dataset.selectionState = selection ? "confirming" : "offered";
        upgradePanel.setAttribute("role", starting ? "dialog" : "complementary");
        if (starting) upgradePanel.setAttribute("aria-modal", "true");
        else upgradePanel.removeAttribute("aria-modal");
        for (const screen of root.querySelectorAll<HTMLElement>("[data-screen]")) screen.inert = starting || !!modal;
        if (!active) {
            if (upgradeActive) {
                if (upgradePanel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
                if (!selection) {
                    upgradeKey = "";
                    upgradeCards.replaceChildren();
                }
            }
            upgradeActive = false;
            return;
        }
        const choiceState = selection?.offer ?? next.upgrade!;
        text("upgrade-title", starting ? "Start of run upgrade" : "Upgrade");
        upgradePanel.querySelector<HTMLElement>(".bs-upgrade-intro")!.hidden = !starting;
        upgradePanel.querySelector<HTMLElement>(".bs-start-quit")!.hidden = !starting;
        message("start-error", starting ? next.error ?? "" : "");
        const startButton = upgradePanel.querySelector<HTMLButtonElement>('[data-action="start-ready"]')!;
        startButton.hidden = !starting || !!selection || choiceState.pending > 0;
        startButton.disabled = !!choiceState.busy;
        startButton.textContent = choiceState.busy ? "Starting…" : "Start run";
        // Extra earned levels only update the queue count; never rebuild or reroll
        // the current offer while the player is aiming or choosing a card.
        const key = `${choiceState.level}:${choiceState.choices.map(choice => `${choice.id}:${choice.nextRank}`).join(",")}`;
        if (key !== upgradeKey) {
            upgradeKey = key;
            const focusedIndex = Math.max(restoreFocus, [...upgradeCards.children].indexOf(document.activeElement as Element));
            upgradeCards.replaceChildren(...choiceState.choices.slice(0, 3).map((choice, index) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "bs-upgrade-card";
                button.dataset.action = "choose-upgrade";
                button.dataset.upgradeId = choice.id;
                button.dataset.rarity = choice.rarity;
                button.dataset.upgradeLevel = String(choiceState.level);
                button.setAttribute("aria-keyshortcuts", String(index + 1));
                button.innerHTML = `<kbd>${index + 1}</kbd><span class="bs-upgrade-copy"><span class="bs-upgrade-card-top"><strong class="bs-upgrade-name"></strong><span class="bs-upgrade-rank"></span></span><span class="bs-upgrade-detail"></span><span class="bs-upgrade-description"></span></span><span class="bs-upgrade-icon" aria-hidden="true">${icon(upgradeArt[choice.id] ?? "target")}</span>`;
                button.querySelector<HTMLElement>(".bs-upgrade-rank")!.textContent = choice.rarity === "special" ? "RARE · UNIQUE" : `R${choice.nextRank}`;
                button.querySelector<HTMLElement>(".bs-upgrade-name")!.textContent = choice.title;
                renderUpgradeText(button.querySelector<HTMLElement>(".bs-upgrade-description")!, choice.descriptionParts);
                renderUpgradeText(button.querySelector<HTMLElement>(".bs-upgrade-detail")!, choice.detailParts);
                button.setAttribute("aria-label", `${choice.title}. ${choice.detail}. ${choice.description} ${choice.rarity === "special" ? "Rare, single-tier upgrade" : `Rank ${choice.nextRank}`}. Press ${index + 1} to choose.`);
                return button;
            }));
            // Preserve deliberate keyboard focus between queued offers without
            // stealing focus or movement input when an offer first appears.
            if (focusedIndex >= 0) upgradeCards.querySelectorAll<HTMLButtonElement>("button")[focusedIndex]?.focus({ preventScroll: true });
        }
        text("upgrade-level", count(choiceState.level));
        for (const button of upgradeCards.querySelectorAll<HTMLButtonElement>("button")) {
            button.disabled = !!selection || !!choiceState.busy;
            if (selection && feedback) {
                const chosen = button.dataset.upgradeId === selection.id;
                button.dataset.selection = chosen ? "selected" : "dismissed";
                button.style.setProperty("--upgrade-opacity", String(chosen ? feedback.selectedOpacity : feedback.dismissedOpacity));
                button.style.setProperty("--upgrade-flash", String(chosen ? feedback.flash : 0));
                button.style.setProperty("--upgrade-scale", String(chosen ? feedback.scale : 1));
                if (chosen) {
                    const choice = choiceState.choices.find(choice => choice.id === selection!.id)!;
                    button.querySelector<HTMLElement>(".bs-upgrade-rank")!.textContent = choice.rarity === "special" ? "✓ UNLOCKED" : `✓ R${choice.nextRank}`;
                    button.setAttribute("aria-label", `${choice.title} selected. ${choice.rarity === "special" ? "Special unlocked" : `Rank ${choice.nextRank}`}.`);
                }
            }
        }
        const remaining = Math.max(0, (next.upgrade?.pending ?? 0) - (selection ? 0 : 1));
        message("upgrade-pending", selection ? "Upgrade applied" : remaining ? `${count(remaining)} queued` : "");
        if (starting && !upgradeActive && !selection) upgradeCards.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
        upgradeActive = true;
    };
    const setPreview = (value: boolean) => {
        previewing = value;
        text("preview-label", value ? "Stop preview" : "Preview with metronome");
    };
    const stopPreview = () => {
        actions.stopPreview();
        setPreview(false);
    };
    const renderAnalysis = (analysis = view?.analysis) => {
        const ready = !!selectedFile && analysis?.state === "ready"
            && (!analysis.fileName || analysis.fileName === selectedFile.name);
        const running = analysis?.state === "running";
        if (ready && previousAnalysisState !== "ready") useAnalysis = true;
        if (!ready) useAnalysis = false;
        previousAnalysisState = ready ? "ready" : analysis?.state ?? "idle";
        const panel = root.querySelector<HTMLElement>(".bs-analysis")!;
        panel.hidden = !selectedFile;
        panel.dataset.analysisState = analysis?.state ?? "idle";
        const analyze = root.querySelector<HTMLButtonElement>('[data-action="analyze-local"]')!;
        analyze.disabled = !selectedFile || running;
        analyze.hidden = running;
        text("analyze-label", ready ? "Analyze again" : "Retry analysis");
        root.querySelector<HTMLElement>('[data-action="cancel-analysis"]')!.hidden = !running;
        const progress = root.querySelector<HTMLProgressElement>(".bs-analysis-progress")!;
        progress.hidden = !running;
        progress.value = Number.isFinite(analysis?.progress) ? Math.min(1, Math.max(0, analysis!.progress!)) : 0;
        message("analysis-message", running ? analysis.message
            : analysis?.state === "error" ? "Analysis failed. Try again."
            : selectedFile && !ready ? "Analysis cancelled." : "");
        const summary = ready ? [
            analysis.bpm === undefined ? "" : `${Math.round(analysis.bpm)} BPM`,
            analysis.duration === undefined ? "" : clock(analysis.duration),
            analysis.structure ? `${analysis.structure.sections.length} sections` : "",
        ].filter(Boolean).join(" · ") : "";
        message("analysis-summary", summary);
        previewElement.hidden = !ready || !analysis?.structure;
        if (!previewElement.hidden) {
            sectionPreview.render(view?.previewPosition ?? 0, analysis!.duration ?? 0, analysis!.structure);
        }
        root.querySelector<HTMLElement>(".bs-timing-options")!.hidden = !selectedFile || running;
        root.querySelector<HTMLElement>(".bs-preview-section")!.hidden = !ready;
        if (!ready) root.querySelector<HTMLSelectElement>("#bs-preview-section")!.value = "start";
        const source = root.querySelector<HTMLSelectElement>("#bs-local-grid")!;
        source.value = useAnalysis ? "detected" : "manual";
        source.disabled = running;
        source.querySelector<HTMLOptionElement>('[value="detected"]')!.disabled = !ready;
        root.querySelector<HTMLElement>(".bs-import-fields")!.hidden = useAnalysis;
        for (const input of root.querySelectorAll<HTMLInputElement>(".bs-import-fields input")) {
            input.disabled = useAnalysis || running;
        }
        for (const action of ["preview-local", "start-local"]) {
            root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.disabled = running;
        }
    };
    const closeModal = (stopAudio = true) => {
        if (!modal) return;
        if (modal === "import" && stopAudio) {
            stopPreview();
            actions.cancelAnalysis();
        }
        for (const element of root.querySelectorAll<HTMLElement>("[data-modal]")) element.hidden = true;
        modal = undefined;
        root.dataset.activeModal = "";
        for (const element of root.querySelectorAll<HTMLElement>("[data-screen]")) element.inert = false;
        previousFocus?.focus();
    };
    const openModal = (next: "settings" | "import") => {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (view?.phase === "playing") actions.pause();
        modal = next;
        root.dataset.activeModal = next;
        for (const element of root.querySelectorAll<HTMLElement>("[data-screen]")) element.inert = true;
        for (const element of root.querySelectorAll<HTMLElement>("[data-modal]")) {
            element.hidden = element.dataset.modal !== next;
        }
        root.querySelector<HTMLElement>(`.bs-modal[data-modal="${next}"] button`)?.focus();
    };
    const run = async (operation: () => void | Promise<unknown>, errorKey = "menu-error") => {
        message(errorKey, "");
        try { await operation(); } catch (error) {
            message(errorKey, error instanceof Error ? error.message : "Unable to start audio. Try another file or reload the page.");
        }
    };
    const localInputs = (): { file: File; bpm: number; offset: number; useAnalysis: boolean } | undefined => {
        if (!selectedFile) {
            message("import-error", "Choose an audio file from your device first.");
            root.querySelector<HTMLInputElement>("#bs-audio-file")?.focus();
            return;
        }
        if (useAnalysis && view?.analysis?.state === "ready") {
            message("import-error", "");
            return { file: selectedFile, bpm: view.analysis.bpm ?? 120, offset: 0, useAnalysis: true };
        }
        const bpm = Number(root.querySelector<HTMLInputElement>("#bs-local-bpm")!.value);
        const offset = Number(root.querySelector<HTMLInputElement>("#bs-local-offset")!.value);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
            message("import-error", "Enter a tempo between 20 and 300 BPM.");
            return;
        }
        if (!Number.isFinite(offset) || offset < 0) {
            message("import-error", "Enter a first-beat offset of zero or more seconds, before the audio ends.");
            return;
        }
        message("import-error", "");
        return { file: selectedFile, bpm, offset, useAnalysis: false };
    };
    root.addEventListener("click", (event) => {
        const target = event.target as Element;
        if (target.closest(".bs-brand")) { event.preventDefault(); return; }
        const button = target.closest<HTMLElement>("[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "choose-upgrade") {
            if (event.detail <= 1) selectUpgrade(button.dataset.upgradeId ?? "", Number(button.dataset.upgradeLevel));
        }
        else if (action === "start-ready") void actions.resume();
        else if (action === "settings") openModal("settings");
        else if (action === "import") openModal("import");
        else if (action === "close-settings" || action === "close-import") closeModal();
        else if (action === "demo") { stopPreview(); void run(() => actions.startDemo()); }
        else if (action === "dojo") {
            const bpm = Number(root.querySelector<HTMLInputElement>("#bs-dojo-bpm")!.value);
            if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) message("menu-error", "Choose a dojo tempo between 20 and 300 BPM.");
            else { stopPreview(); void run(() => actions.startDojo(bpm)); }
        } else if (action === "pause") actions.pause();
        else if (action === "resume") void run(() => actions.resume());
        else if (action === "retry") { closeModal(); void run(() => actions.retry()); }
        else if (action === "quit") { closeModal(); stopPreview(); actions.quit(); }
        else if (action === "reset-dojo") actions.resetDojo();
        else if (action === "reset-settings") actions.resetSettings();
        else if (action === "analyze-local") {
            if (!selectedFile) return;
            stopPreview();
            const file = selectedFile;
            void run(() => actions.analyzeLocal(file), "import-error");
        } else if (action === "cancel-analysis") {
            actions.cancelAnalysis();
            root.querySelector<HTMLInputElement>("#bs-audio-file")?.focus();
        }
        else if (action === "preview-local") {
            if (previewing) { stopPreview(); return; }
            const inputs = localInputs();
            if (inputs) {
                const section = root.querySelector<HTMLSelectElement>("#bs-preview-section")!.value as "start" | "middle" | "end" | "full";
                setPreview(true);
                void run(async () => {
                    try { await actions.previewLocal(inputs.file, inputs.bpm, inputs.offset, inputs.useAnalysis, section); }
                    catch (error) { setPreview(false); throw error; }
                }, "import-error");
            }
        } else if (action === "start-local") {
            const inputs = localInputs();
            if (inputs) {
                stopPreview();
                void run(() => actions.startLocal(inputs.file, inputs.bpm, inputs.offset, inputs.useAnalysis), "import-error");
            }
        }
    }, { signal: events.signal });
    root.addEventListener("change", (event) => {
        const target = event.target as HTMLInputElement;
        if (target.id === "bs-audio-file") {
            stopPreview();
            actions.clearAnalysis();
            useAnalysis = false;
            previousAnalysisState = "idle";
            selectedFile = target.files?.[0];
            root.querySelector<HTMLDetailsElement>(".bs-timing-options")!.open = false;
            root.querySelector<HTMLSelectElement>("#bs-preview-section")!.value = "start";
            text("file-name", selectedFile?.name ?? "Choose an audio file");
            refs.get("local-reselect")!.hidden = !!selectedFile || !view?.lastLocal;
            message("import-error", "");
            renderAnalysis({ state: "idle", message: "" });
            if (selectedFile) {
                const file = selectedFile;
                void run(() => actions.analyzeLocal(file), "import-error");
            }
        }
        if (target.id === "bs-dojo-bpm" || target.id === "bs-local-bpm") {
            if (target.value && Number.isFinite(target.valueAsNumber)) target.value = String(Math.round(target.valueAsNumber));
        }
        if (target.id === "bs-local-bpm" || target.id === "bs-local-offset") stopPreview();
        if (target.id === "bs-preview-section") stopPreview();
        if (target.id === "bs-local-grid") {
            stopPreview();
            useAnalysis = target.value === "detected";
            renderAnalysis();
        }
    }, { signal: events.signal });
    root.addEventListener("input", (event) => {
        const target = event.target as HTMLInputElement;
        const key = target.dataset.setting as keyof Settings | undefined;
        if (!key) return;
        const value = key === "reducedFlash" ? target.checked
            : key === "graphics" || key === "effectsIntensity" ? target.value : Number(target.value);
        actions.updateSettings({ [key]: value });
    }, { signal: events.signal });
    window.addEventListener("keydown", (event) => {
        if (upgradeActive && upgradePanel.classList.contains("bs-start-upgrade")) {
            if (event.code === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); return; }
            if (event.code === "Tab") {
                const controls = [...upgradePanel.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(el => el.checkVisibility());
                const first = controls[0], last = controls.at(-1);
                if (!upgradePanel.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                return;
            }
        }
        if (upgradeActive && !modal && !(event.target as HTMLElement)?.matches("input,select,textarea,[contenteditable='true']")) {
            if (/^(Digit|Numpad)[123]$/.test(event.code) && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const choice = view?.upgrade?.choices[Number(event.code.at(-1)) - 1];
                if (!event.repeat && choice) selectUpgrade(choice.id, view!.upgrade!.level);
                return;
            }
            // Space remains dash even when a clicked card has keyboard focus.
            if (view?.phase === "playing" && event.code === "Space" && (event.target as HTMLElement)?.closest(".bs-upgrade-card")) event.preventDefault();
        }
        if (!modal) return;
        if (event.code === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeModal();
        } else if (event.code === "Tab") {
            const panel = root.querySelector<HTMLElement>(`[data-modal="${modal}"]`)!;
            const controls = [...panel.querySelectorAll<HTMLElement>("button, input, select, summary, [tabindex='0']")]
                .filter((element) => !element.matches(":disabled") && element.checkVisibility());
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }, { signal: events.signal, capture: true });
    return {
        render(next) {
            view = next;
            root.dataset.phase = next.phase;
            root.classList.toggle("bs-reduced-flash", next.settings.reducedFlash);
            root.classList.toggle("bs-graphics-low", next.settings.graphics === "low");
            root.dataset.effectsIntensity = next.settings.effectsIntensity;
            const phaseChanged = previousPhase !== next.phase;
            // The session owner already stopped preview audio when changing phase. Do not
            // issue another stop/cancel here: that could cancel its new asynchronous load.
            if (phaseChanged && next.phase !== "menu" && next.phase !== "paused") closeModal(false);
            previousPhase = next.phase;
            for (const element of root.querySelectorAll<HTMLElement>("[data-screen]")) {
                const screen = element.dataset.screen;
                element.hidden = screen === "hud"
                    ? !["playing", "paused", "starting"].includes(next.phase)
                    : screen !== next.phase;
            }
            renderUpgrade(next);
            if (phaseChanged && next.phase === "paused") root.querySelector<HTMLElement>('[data-action="resume"]')?.focus();
            if (phaseChanged && next.phase === "results") root.querySelector<HTMLElement>('[data-screen="results"] [data-action="retry"]')?.focus();
            const demo = next.demo ?? (next.mode !== "local" && next.phase === "menu" ? {
                title: DEMO_TRACK.title, credit: DEMO_TRACK.artist,
                duration: DEMO_TRACK.duration, bpm: DEMO_TRACK.bpm, bestScore: next.bestScore,
            } : undefined);
            if (demo) {
                text("demo-title", demo.title);
                text("demo-credit", demo.credit);
                text("demo-bpm", String(Math.round(demo.bpm)));
                text("demo-duration", clock(demo.duration));
                text("demo-best", demo.bestScore ? count(demo.bestScore) : "—");
            }
            if (phaseChanged || next.error !== previousExternalError) {
                message("menu-error", next.error ?? "");
                message("session-error", next.error ?? "");
                if (modal === "import") message("import-error", next.error ?? "");
            }
            previousExternalError = next.error;
            if (next.previewing !== undefined) setPreview(next.previewing);
            renderAnalysis();
            if (next.lastLocal) {
                text("local-reselect", `Last track: ${next.lastLocal.name}`);
                refs.get("local-reselect")!.hidden = !!selectedFile;
                if (!appliedLocalMetadata) {
                    root.querySelector<HTMLInputElement>("#bs-local-bpm")!.value = String(Math.round(next.lastLocal.bpm));
                    root.querySelector<HTMLInputElement>("#bs-local-offset")!.value = String(next.lastLocal.offset);
                    appliedLocalMetadata = true;
                }
            }
            text("track-title", next.title ?? (next.mode === "dojo" ? "The dojo" : "Neon Circuit"));
            text("mode-label", next.mode === "dojo" ? "PRACTICE" : "LIVE");
            text("health-label", `${Math.ceil(Math.max(0, next.health ?? 100))} / ${next.maxHealth ?? 100}`);
            const health = root.querySelector<HTMLProgressElement>(".bs-health")!;
            health.max = next.maxHealth ?? 100;
            health.value = Math.max(0, next.health ?? 100);
            health.classList.toggle("bs-health-low", health.value / health.max <= 0.3);
            const shield = root.querySelector<HTMLElement>(".bs-shield-status")!;
            shield.hidden = !next.shield;
            shield.dataset.ready = String(!!next.shield?.ready);
            text("shield-status", next.shield?.ready ? "Ready" : `${Math.ceil(next.shield?.remaining ?? 0)}s`);
            const level = Math.max(1, Math.floor(next.level ?? 1));
            const requiredXp = Math.max(1, Math.floor(next.requiredXp ?? 30));
            const xp = Math.min(requiredXp, Math.max(0, Math.floor(next.xp ?? 0)));
            text("level", count(level));
            text("xp", count(xp));
            text("xp-required", count(requiredXp));
            const experience = refs.get("xp-progress") as HTMLProgressElement;
            experience.max = requiredXp;
            experience.value = xp;
            experience.setAttribute("aria-valuetext", `Level ${level}, ${xp} of ${requiredXp} experience to next level`);
            text("score", count(next.score));
            text("kills", count(next.kills));
            text("bpm", String(Math.round(next.bpm ?? 120)));
            text("count-in", (next.position ?? 0) < 0
                ? `COUNT IN · ${Math.max(1, Math.ceil(-(next.position ?? 0) * (next.bpm ?? 120) / 60))}`
                : "");
            refs.get("count-in")!.hidden = (next.position ?? 0) >= 0;
            text("bar", String(Math.max(1, (next.bar ?? 0) + 1)).padStart(2, "0"));
            const beatInBar = next.beatInBar ?? -1;
            const beatsPerBar = Math.min(16, Math.max(1, Math.floor(next.beatsPerBar ?? 4)));
            const dots = root.querySelector<HTMLElement>(".bs-beat-dots")!;
            while (dots.children.length < beatsPerBar) dots.append(document.createElement("i"));
            while (dots.children.length > beatsPerBar) dots.lastElementChild?.remove();
            dots.setAttribute("aria-label", beatInBar >= 0 ? `Beat ${beatInBar + 1} of ${beatsPerBar}` : `${beatsPerBar} beats per bar`);
            for (const [index, dot] of [...dots.children].entries()) {
                dot.classList.toggle("bs-active", index === beatInBar);
                dot.classList.toggle("bs-downbeat", index === beatInBar && next.downbeat === true);
                dot.classList.toggle("bs-dash-ready", next.dashState === "ready" && index === next.dashBeatInBar);
            }
            const dashState = next.dashState ?? "waiting";
            const dash = root.querySelector<HTMLElement>(".bs-dash-status")!;
            dash.dataset.dashState = dashState;
            root.querySelector<HTMLElement>(".bs-hud-beat")!.dataset.dashState = dashState;
            text("dash-status", dashState === "ready" ? "Dash ready"
                : dashState === "used" ? "Used · next bar"
                : dashState === "dashing" ? "Dashing" : "Dash on beat");
            trackPlayer.render(next.position ?? 0, next.duration ?? 0, next.structure, next.mode === "dojo");
            const reset = root.querySelector<HTMLElement>('[data-action="reset-dojo"]')!;
            reset.hidden = next.mode !== "dojo";
            text("loading-message", next.loadingMessage ?? "Loading audio…");
            text("pause-reason", next.pauseReason ?? "");
            text("result-title", next.result === "defeat" ? "Game over" : "Track complete");
            text("result-score", count(next.score));
            text("result-kills", count(next.kills));
            text("result-time", clock(next.position ?? 0));
            text("result-best", count(next.bestScore));
            text("result-level", count(level));
            text("result-xp", count(next.totalXp));
            text("best-label", (next.score ?? 0) >= (next.bestScore ?? 0) && (next.score ?? 0) > 0 ? "PERSONAL BEST" : "");
            text("diagnostics", next.diagnostics ?? "");
            refs.get("diagnostics")!.hidden = !next.diagnostics;
            for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]")) {
                const key = input.dataset.setting as keyof Settings;
                const value = next.settings[key];
                if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
                else if (document.activeElement !== input) input.value = String(value);
                const output = root.querySelector<HTMLOutputElement>(`[data-output="${key}"]`);
                if (output) output.value = key === "timingOffsetMs"
                    ? `${Number(value) > 0 ? "+" : ""}${value} ms`
                    : `${Math.round(Number(value) * 100)}%`;
            }
        },
        dispose() {
            events.abort();
            clearSelection();
            // The session owner disposes audio; calling back into its World here
            // would be unsafe during World.onDispose.
            previewing = false;
            selectedFile = undefined;
            root.remove();
        },
    };
}
