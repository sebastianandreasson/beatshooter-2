/**
 * Explicit local-file experiment, excluded from CI and automatic test discovery.
 * bun tests/audio-analysis.ts [http://127.0.0.1:4174] [--headed]
 * Selects files through the real UI. No track bytes are sent over HTTP.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { arch, cpus, platform, release } from "node:os";
import { chromium, type Page } from "playwright";
import { BROWSER_CONFIG } from "@dylanebert/shallot/testing";
import type { BeatAnalysis } from "../src/analysis/types";
import { sampleEnergy, validateEnergyCurve } from "../src/analysis/energy";

type Witness = {
    phase: string;
    position: number;
    audioState?: string;
    preview: { active: boolean; position: number; until: number };
    pending: number;
    entityCount: number;
    sounds: number;
    analysis?: { state: string; message: string; bpm?: number; warnings?: string[]; beatCount?: number; downbeatCount?: number; elapsedMs?: number };
    chart: { id: string; bpm: number; beatCount: number; downbeatCount: number };
    combat: { health: number; score: number; enemies: number; projectiles: number };
    visuals: {
        shaderStatus: string; activeShards: number; activeRings: number;
        frame: { position: number; active: boolean; strength: number };
        shaderInput: { energy: number; bass: number };
    };
};
type InspectionWindow = Window & {
    __beatshooter?: { snapshot(): Witness; analysis(): BeatAnalysis | null };
};

const origin = Bun.argv.slice(2).find(argument => !argument.startsWith("--")) ?? "http://127.0.0.1:4174";
const files = (await readdir("local-audio")).filter(file => /\.(mp3|wav|m4a|ogg|flac)$/i.test(file)).sort();
if (!files.length) throw new Error("Add local test tracks to the gitignored local-audio directory.");
const directory = "output/audio-analysis";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
    ...BROWSER_CONFIG.use.launchOptions,
    channel: BROWSER_CONFIG.use.channel,
    headless: !Bun.argv.includes("--headed"),
});
const snapshot = (page: Page) => page.evaluate(() => (window as InspectionWindow).__beatshooter!.snapshot());
const waitPhase = (page: Page, phase: string) => page.waitForFunction(
    phase => (window as InspectionWindow).__beatshooter!.snapshot().phase === phase, phase, { timeout: 30_000 },
);
const round = (value: number) => Math.round(value * 1000) / 1000;

function comparison(actual: number[], expected: number[]) {
    let matched = 0, cursor = 0;
    const errors: number[] = [];
    for (const time of expected) {
        while (cursor < actual.length && actual[cursor]! < time - 0.07) cursor++;
        if (cursor < actual.length && Math.abs(actual[cursor]! - time) <= 0.07) {
            errors.push(Math.abs(actual[cursor++]! - time));
            matched++;
        }
    }
    errors.sort((a, b) => a - b);
    const precision = matched / Math.max(1, actual.length), recall = matched / expected.length;
    return {
        toleranceMilliseconds: 70, matched, expected: expected.length, detected: actual.length,
        precision: round(precision), recall: round(recall),
        f1: round(2 * precision * recall / Math.max(Number.EPSILON, precision + recall)),
        medianErrorMilliseconds: round((errors[Math.floor(errors.length / 2)] ?? Infinity) * 1000),
        p95ErrorMilliseconds: round((errors[Math.ceil(errors.length * 0.95) - 1] ?? Infinity) * 1000),
    };
}

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    context.on("request", request => {
        const url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) return;
        if (url.origin !== new URL(origin).origin || request.method() !== "GET") {
            unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        }
    });
    page.on("console", message => {
        if (message.type() === "error") console.error("browser:", message.text());
    });
    await page.goto(`${origin}/?test=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!(window as InspectionWindow).__beatshooter, undefined, { timeout: 60_000 });
    await waitPhase(page, "menu");
    console.log("Game ready; checking missing model and cancellation.");
    const environment = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return {
            userAgent: navigator.userAgent, crossOriginIsolated, devicePixelRatio,
            gpu: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null,
        };
    });
    await page.getByRole("button", { name: "Import local audio" }).click();

    // Missing assets must fail usefully, with manual controls still available.
    await context.route("**/models/beat-this.onnx", route => route.fulfill({ status: 404, body: "Missing test model" }));
    await page.locator("#bs-audio-file").setInputFiles(resolve("public/tracks/neon-circuit.wav"));
    await page.waitForFunction(() => ["error", "ready"].includes((window as InspectionWindow).__beatshooter!.snapshot().analysis?.state ?? ""),
        undefined, { timeout: 60_000 });
    if ((await snapshot(page)).analysis?.state !== "error") throw new Error("Missing model interception did not fail analysis.");
    const missingModelMessage = (await snapshot(page)).analysis!.message;
    if (await page.locator('[data-action="start-local"]').isDisabled()) throw new Error("Manual fallback blocked after model error.");
    await context.unroute("**/models/beat-this.onnx");

    // Cancel actual model loading/inference without waiting for the whole song.
    await page.locator('[data-action="analyze-local"]').click();
    await page.waitForFunction(() => /Loading beat model|Finding beats/.test(
        (window as InspectionWindow).__beatshooter!.snapshot().analysis?.message ?? ""),
        undefined, { timeout: 60_000 });
    await page.locator('[data-action="cancel-analysis"]').click();
    await page.waitForFunction(() => (window as InspectionWindow).__beatshooter!.snapshot().analysis?.state === "idle");
    const cancelled = await snapshot(page);
    if (cancelled.phase !== "menu" || cancelled.sounds !== 0) throw new Error("Cancellation started playback.");

    const results: Record<string, unknown>[] = [];
    const inputs = ["public/tracks/neon-circuit.wav", ...files.map(file => `local-audio/${file}`)];
    for (const [index, path] of inputs.entries()) {
        if (index > 0) await page.getByRole("button", { name: "Import local audio" }).click();
        await page.locator("#bs-audio-file").setInputFiles(resolve(path));
        const started = performance.now();
        console.log(`Analyzing ${path}...`);
        await page.waitForFunction(() => ["ready", "error"].includes(
            (window as InspectionWindow).__beatshooter!.snapshot().analysis?.state ?? ""),
            undefined, { timeout: 600_000 });
        const state = await snapshot(page);
        if (state.analysis?.state !== "ready") throw new Error(`${path}: ${state.analysis?.message}`);
        const analysis = await page.evaluate(() => (window as InspectionWindow).__beatshooter!.analysis());
        if (!analysis) throw new Error("Ready analysis missing.");
        if (!validateEnergyCurve(analysis.energy, analysis.duration)) throw new Error("Missing or invalid local energy curves.");
        const ownsMetadata = await page.evaluate(() => {
            const api = (window as InspectionWindow).__beatshooter!;
            const copy = api.analysis()!;
            const original = copy.energy!.loudness[0]!;
            copy.energy!.loudness[0] = original === 0 ? 1 : 0;
            return api.analysis()!.energy!.loudness[0] === original;
        });
        if (!ownsMetadata) throw new Error("Inspection exposed mutable retained energy metadata.");
        if (await page.locator("#bs-local-grid").inputValue() !== "detected") throw new Error("Detected chart not selected.");
        const wallMs = performance.now() - started;
        const stem = `track-${index}`;
        await page.screenshot({ path: `${directory}/${stem}.png`, fullPage: true });
        await writeFile(`${directory}/${stem}-beats.json`, JSON.stringify(analysis, null, 2) + "\n");
        const demoTruth = index === 0 ? {
            beats: comparison(analysis.beats, Array.from({ length: 144 }, (_, i) => i / 2)),
            downbeats: comparison(analysis.downbeats, Array.from({ length: 36 }, (_, i) => i * 2)),
        } : undefined;
        if (demoTruth && (demoTruth.beats.recall < 0.9 || demoTruth.beats.precision < 0.9)) {
            throw new Error(`Known demo failed timing sanity check: ${JSON.stringify(demoTruth)}`);
        }

        // Normal UI uses the same prepared file for metronome preview and gameplay.
        await page.locator('[data-action="preview-local"]').click();
        await page.waitForFunction(() => (window as InspectionWindow).__beatshooter!.snapshot().audioState === "playing");
        await page.waitForTimeout(1200);
        await page.locator('[data-action="preview-local"]').click();
        if (index === 0) {
            for (const section of ["middle", "end", "full"]) {
                await page.getByLabel("Preview section").selectOption(section);
                await page.locator('[data-action="preview-local"]').click();
                await page.waitForFunction(() => (window as InspectionWindow).__beatshooter!.snapshot().preview.active);
                const preview = (await snapshot(page)).preview;
                const expectedStart = section === "middle" ? 30 : section === "end" ? 60 : 0;
                const expectedEnd = section === "middle" ? 42 : 72;
                if (Math.abs(preview.position - expectedStart) > 1 || preview.until !== expectedEnd) {
                    throw new Error(`Incorrect ${section} preview: ${JSON.stringify(preview)}`);
                }
                await page.locator('[data-action="preview-local"]').click();
            }
        }
        await page.locator('[data-action="start-local"]').click();
        await waitPhase(page, "playing");
        await page.waitForFunction(() => (window as InspectionWindow).__beatshooter!.snapshot().combat.score > 0,
            undefined, { timeout: 30_000 });
        await page.keyboard.press("Escape");
        await waitPhase(page, "paused");
        const played = await snapshot(page);
        if (!played.chart.id.startsWith("analyzed-") || played.chart.beatCount !== analysis.beats.length) {
            throw new Error("Gameplay did not consume the analyzed chart.");
        }
        const energy = sampleEnergy(analysis.energy, played.visuals.frame.position);
        if (played.visuals.shaderStatus !== "ready" ||
            Math.abs(played.visuals.shaderInput.energy - energy.loudness) > 0.00001 ||
            Math.abs(played.visuals.shaderInput.bass - energy.bass) > 0.00001 ||
            played.visuals.activeShards > 256 || played.visuals.activeRings > 8) {
            throw new Error("Gameplay did not sample local energy on the shared musical clock.");
        }
        await page.getByRole("button", { name: "Restart session" }).click();
        await waitPhase(page, "playing");
        if ((await snapshot(page)).chart.id !== played.chart.id) throw new Error("Retry changed the chart.");
        await page.keyboard.press("Escape");
        await waitPhase(page, "paused");
        await page.getByRole("button", { name: "Return to menu", exact: true }).click();
        await waitPhase(page, "menu");
        const clean = await snapshot(page);
        if (clean.sounds || clean.entityCount || clean.pending) throw new Error("Menu return leaked session state.");
        const result = {
            file: path.split("/").at(-1), durationSeconds: round(analysis.duration),
            beatCount: analysis.beats.length, downbeatCount: analysis.downbeats.length,
            estimatedBpm: state.analysis.bpm, analysisMilliseconds: round(analysis.elapsedMs),
            clickToReadyMilliseconds: round(wallMs), backend: analysis.backend,
            warnings: state.analysis.warnings, chartId: played.chart.id,
            previewPlayRetryCleanup: "passed", previewSections: index === 0 ? "start/middle/end/full passed" : "start passed",
            musicalVisuals: { shader: "ready", energyFrames: analysis.energy!.loudness.length,
                sharedClockEnergy: "passed", gapGuardActive: !played.visuals.frame.active },
            groundTruthComparison: demoTruth,
        };
        results.push(result);
        console.log(JSON.stringify(result));
    }
    if (unexpectedRequests.length) throw new Error(`Unexpected network requests: ${unexpectedRequests.join(", ")}`);
    if (errors.length) throw new Error(`Uncaught browser errors: ${errors.join("; ")}`);
    const report = {
        recordedAt: new Date().toISOString(),
        environment: {
            platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model,
            bun: Bun.version, browser: browser.version(), ...environment,
        },
        scenario: "Real local-file import, full-track WebGPU inference, preview, play, retry and cleanup. Generated demo has known timestamps; user tracks have no hand-labeled beat ground truth.",
        missingModelRecovery: { passed: true, message: missingModelMessage },
        cancellation: { passed: true }, unexpectedRequests, pageErrors: errors, results,
    };
    await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${directory}/report.json`);
} finally {
    await browser.close();
}
