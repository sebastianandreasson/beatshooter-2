/**
 * Sequential production renderer comparison; intentionally outside test-discovery suffixes.
 * Serve the current build first. This script does not build, serve, or modify application code.
 * Run: bun tests/music-visuals-benchmark.ts [http://127.0.0.1:4175] [--headed]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { BROWSER_CONFIG } from "@dylanebert/shallot/testing";
import { chromium, type Browser } from "playwright";
import { DEFAULT_SETTINGS, STORAGE_KEY, validatePreferences } from "../src/settings";

interface VisualSnapshot {
    phase: string;
    position: number;
    audioState?: string;
    combat: { health: number; enemies: number; projectiles: number; effects: number };
    entityCount: number;
    sounds: number;
    visuals: {
        intensity: number;
        motionAllowed: boolean;
        activeShards: number;
        activeRings: number;
        pendingBursts: number;
        feedback: number;
        poolCapacity: number;
        shaderStatus: string;
        shaderError?: string;
        visualCpuMs?: number;
        visualStressBursts?: number;
    };
}
type InspectedWindow = Window & { __beatshooter?: { snapshot(): VisualSnapshot } };
type Mode = "off" | "standard";

const WARMUP_MS = 3000;
const FRAMES = 600;
const FRAME_BUDGET_MS = 1000 / 60;
const TIMESTAMP_TOLERANCE_MS = 0.1;
const viewport = { width: 1200, height: 924 };
const headed = Bun.argv.includes("--headed");
const origin = Bun.argv.slice(2).find(argument => !argument.startsWith("--")) ?? "http://127.0.0.1:4175";
const url = new URL(origin);
url.searchParams.set("test", "1");
url.searchParams.set("stress", "1");
url.searchParams.set("visualStress", "1");
const round = (value: number) => Math.round(value * 1000) / 1000;
const range = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });
function statistics(values: number[]) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (value: number) => sorted[Math.ceil(sorted.length * value) - 1]!;
    return {
        count: values.length,
        mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
        p50: round(percentile(0.5)),
        p95: round(percentile(0.95)),
        p99: round(percentile(0.99)),
        max: round(sorted.at(-1)!),
    };
}

async function measure(browser: Browser, mode: Mode) {
    const preferences = validatePreferences({
        version: 1,
        settings: { ...DEFAULT_SETTINGS, effectsIntensity: mode, graphics: "high", reducedFlash: false },
        bestScores: {},
    });
    const context = await browser.newContext({
        viewport, deviceScaleFactor: 1, reducedMotion: "no-preference",
    });
    try {
        await context.addInitScript(({ key, value }) => {
            localStorage.setItem(key, JSON.stringify(value));
        }, { key: STORAGE_KEY, value: preferences });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(
            () => Boolean((window as InspectedWindow).__beatshooter), undefined, { timeout: 60_000 },
        );
        await page.getByRole("button", { name: /^Practice/ }).click();
        await page.waitForFunction(() => {
            const s = (window as InspectedWindow).__beatshooter!.snapshot();
            return s.phase === "playing" && s.position >= 0;
        }, undefined, { timeout: 30_000 });
        await page.waitForTimeout(WARMUP_MS);

        const environment = await page.evaluate(async () => {
            const adapter = await navigator.gpu?.requestAdapter();
            const info = adapter?.info;
            return {
                userAgent: navigator.userAgent, devicePixelRatio, crossOriginIsolated,
                gpu: info ? {
                    vendor: info.vendor, architecture: info.architecture,
                    device: info.device, description: info.description,
                } : null,
            };
        });
        const measurement = await page.evaluate(frames => new Promise<{
            intervals: number[];
            cpu: number[];
            counts: {
                enemies: number[]; projectiles: number[]; feedback: number[];
                shards: number[]; rings: number[]; pendingBursts: number[]; entities: number[];
            };
            phases: string[];
            shaders: string[];
            first: VisualSnapshot;
            final: VisualSnapshot;
        }>((resolve, reject) => {
            const intervals: number[] = [], cpu: number[] = [];
            const counts = {
                enemies: [] as number[], projectiles: [] as number[], feedback: [] as number[],
                shards: [] as number[], rings: [] as number[], pendingBursts: [] as number[],
                entities: [] as number[],
            };
            const phases = new Set<string>(), shaders = new Set<string>();
            const first = (window as InspectedWindow).__beatshooter!.snapshot();
            let previous: number | undefined;
            const timeout = setTimeout(() => reject(new Error("Animation-frame measurement exceeded 60 seconds.")), 60_000);
            const frame = (time: number) => {
                const s = (window as InspectedWindow).__beatshooter!.snapshot();
                if (previous !== undefined) {
                    intervals.push(time - previous);
                    counts.enemies.push(s.combat.enemies);
                    counts.projectiles.push(s.combat.projectiles);
                    counts.feedback.push(s.visuals.feedback);
                    counts.shards.push(s.visuals.activeShards);
                    counts.rings.push(s.visuals.activeRings);
                    counts.pendingBursts.push(s.visuals.pendingBursts);
                    counts.entities.push(s.entityCount);
                    const visualCpu = s.visuals.visualCpuMs;
                    if (typeof visualCpu === "number" && Number.isFinite(visualCpu)) cpu.push(visualCpu);
                    phases.add(s.phase);
                    shaders.add(s.visuals.shaderStatus);
                }
                previous = time;
                if (intervals.length === frames) {
                    clearTimeout(timeout);
                    resolve({ intervals, cpu, counts, phases: [...phases], shaders: [...shaders], first, final: s });
                } else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        }), FRAMES);

        const checks: string[] = [];
        const check = (condition: boolean, message: string) => { if (!condition) checks.push(message); };
        check(measurement.phases.length === 1 && measurement.phases[0] === "playing",
            `Session changed phase: ${measurement.phases.join(", ")}.`);
        check(measurement.shaders.length === 1 && measurement.shaders[0] === "ready",
            `Shader was not ready: ${measurement.shaders.join(", ")}; ${measurement.final.visuals.shaderError ?? ""}`);
        check(measurement.final.audioState === "playing" && measurement.final.combat.health > 0,
            "Audio clock or player did not remain active.");
        check(measurement.final.position > measurement.first.position + 1, "Song clock did not advance.");
        check(Math.max(...measurement.counts.enemies) === 200 &&
            Math.max(...measurement.counts.projectiles) <= 500 && Math.min(...measurement.counts.projectiles) > 0,
        "The 200-enemy/500-projectile refill fixture was not active.");
        check(Math.max(...measurement.counts.shards) <= 256 && Math.max(...measurement.counts.rings) <= 8 &&
            Math.max(...measurement.counts.pendingBursts) <= 16 && Math.max(...measurement.counts.feedback) <= 100,
        "A cosmetic capacity limit was exceeded.");
        check(measurement.final.visuals.poolCapacity === 256, "Unexpected fixed particle pool capacity.");
        if (mode === "off") {
            check(measurement.final.visuals.intensity === 0 && !measurement.final.visuals.motionAllowed,
                "Off preferences were not applied.");
            check(Math.max(...measurement.counts.shards) === 0 && Math.max(...measurement.counts.rings) === 0,
                "Off mode rendered cosmetic particles.");
        } else {
            check(measurement.final.visuals.intensity > 0 && measurement.final.visuals.motionAllowed,
                "Standard preferences were not applied.");
            check(Math.max(...measurement.counts.shards) >= 128 && Math.max(...measurement.counts.rings) > 0,
                "The crowded visual-burst fixture did not create enough particles.");
        }

        const screenshot = `output/playwright/music-stress-${mode}.png`;
        await page.screenshot({ path: screenshot });
        if (measurement.final.phase === "playing") await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Return to menu", exact: true }).click();
        await page.waitForFunction(() => {
            const s = (window as InspectedWindow).__beatshooter!.snapshot();
            return s.phase === "menu" && s.entityCount === 0 && s.sounds === 0 &&
                s.visuals.activeShards === 0 && s.visuals.activeRings === 0 &&
                s.visuals.pendingBursts === 0 && s.visuals.feedback === 0;
        }, undefined, { timeout: 10_000 });
        const cleanup = await page.evaluate(() => (window as InspectedWindow).__beatshooter!.snapshot());
        check(pageErrors.length === 0, `Uncaught browser errors: ${pageErrors.join("; ")}`);
        const frameStats = statistics(measurement.intervals)!;
        const targetMet = frameStats.mean <= FRAME_BUDGET_MS + TIMESTAMP_TOLERANCE_MS &&
            frameStats.p95 <= FRAME_BUDGET_MS + TIMESTAMP_TOLERANCE_MS;
        check(targetMet, "Mean/p95 frame cadence exceeded the 60 Hz target.");
        return {
            mode, settings: preferences.settings, environment,
            frameIntervalsMilliseconds: frameStats,
            averageFramesPerSecond: round(1000 / frameStats.mean),
            target60Fps: { met: targetMet, frameBudgetMilliseconds: round(FRAME_BUDGET_MS), timestampToleranceMilliseconds: TIMESTAMP_TOLERANCE_MS },
            visualCpuMilliseconds: statistics(measurement.cpu),
            visualCpuScope: measurement.cpu.length
                ? "Event consumption, particle updates and floor uniform upload; excludes musical frame sampling, damage-number DOM, and renderer/GPU work."
                : "Not exposed by this build; no CPU timing inferred from frame intervals.",
            observedCounts: Object.fromEntries(Object.entries(measurement.counts).map(([name, values]) => [name, range(values)])),
            shaderStatus: measurement.shaders,
            visualStressBursts: measurement.final.visuals.visualStressBursts ?? null,
            cleanup: {
                phase: cleanup.phase, sessionEntities: cleanup.entityCount, sounds: cleanup.sounds,
                activeShards: cleanup.visuals.activeShards, activeRings: cleanup.visuals.activeRings,
                pendingBursts: cleanup.visuals.pendingBursts, feedback: cleanup.visuals.feedback,
                retainedPoolCapacity: cleanup.visuals.poolCapacity,
            },
            pageErrors, screenshot, passed: checks.length === 0, failures: checks,
            rawFrameIntervalsMilliseconds: measurement.intervals,
        };
    } finally {
        await context.close();
    }
}

await mkdir("output/playwright", { recursive: true });
const browser = await chromium.launch({
    ...BROWSER_CONFIG.use.launchOptions,
    channel: BROWSER_CONFIG.use.channel,
    headless: !headed,
});
try {
    const off = await measure(browser, "off");
    const standard = await measure(browser, "standard");
    const report = {
        recordedAt: new Date().toISOString(),
        machine: {
            platform: platform(), release: release(), architecture: arch(),
            cpu: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length,
            memoryGiB: round(totalmem() / 1024 ** 3),
        },
        runtime: { bun: Bun.version, browser: `Chromium ${browser.version()}`, mode: headed ? "headed" : "headless" },
        scenario: {
            url: url.href, viewport, deviceScaleFactor: 1, order: ["off", "standard"],
            warmupMillisecondsAfterCountIn: WARMUP_MS, measuredFramesPerMode: FRAMES,
            fixture: { enemiesPerFixedStep: 200, projectilesPerFixedStep: 500, cosmeticKillBurstsPerBeat: 16 },
            scope: "Real Shallot rendering, physics, audio, combat, floor shader and bounded particles. Fresh contexts run sequentially, with a read-only snapshot each frame.",
            limitation: "Frame intervals include display pacing and inspection overhead. Vsync-limited comparisons do not measure GPU headroom and cannot establish a 2 ms GPU budget. CPU instrumentation, when available, excludes GPU work.",
        },
        runs: [off, standard],
        differenceStandardMinusOffMilliseconds: {
            meanFrameInterval: round(standard.frameIntervalsMilliseconds.mean - off.frameIntervalsMilliseconds.mean),
            p95FrameInterval: round(standard.frameIntervalsMilliseconds.p95 - off.frameIntervalsMilliseconds.p95),
            meanVisualCpu: standard.visualCpuMilliseconds && off.visualCpuMilliseconds
                ? round(standard.visualCpuMilliseconds.mean - off.visualCpuMilliseconds.mean) : null,
            p95VisualCpu: standard.visualCpuMilliseconds && off.visualCpuMilliseconds
                ? round(standard.visualCpuMilliseconds.p95 - off.visualCpuMilliseconds.p95) : null,
        },
        passed: off.passed && standard.passed,
    };
    const destination = "output/playwright/music-visuals-benchmark.json";
    await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({
        report: destination, passed: report.passed,
        runs: report.runs.map(({ mode, frameIntervalsMilliseconds, visualCpuMilliseconds, observedCounts, failures }) =>
            ({ mode, frameIntervalsMilliseconds, visualCpuMilliseconds, observedCounts, failures })),
        differenceStandardMinusOffMilliseconds: report.differenceStandardMinusOffMilliseconds,
    }, null, 2));
    if (!report.passed) throw new Error(`Music-visual benchmark failed; see ${destination}.`);
} finally {
    await browser.close();
}
