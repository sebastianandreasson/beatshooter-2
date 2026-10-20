/**
 * Explicit rendering/physics benchmark; not discovered as a unit/browser test.
 * Serve an existing production build first; this script never rebuilds it.
 * Run: bun tests/browser-stress.ts [http://127.0.0.1:4175] [--headed]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { BROWSER_CONFIG } from "@dylanebert/shallot/testing";
import { chromium } from "playwright";

interface StressSnapshot {
    phase: string;
    position: number;
    audioState?: string;
    combat: { health: number; enemies: number; projectiles: number; effects: number };
    entityCount: number;
    sounds: number;
}
type StressWindow = Window & { __beatshooter?: { snapshot(): StressSnapshot } };

const WARMUP_MS = 3000;
const FRAMES = 600;
// Browser timestamp quantization can report a 60 Hz interval as 16.67 ms.
const TIMESTAMP_TOLERANCE_MS = 0.1;
const viewport = { width: 1200, height: 924 };
const headed = Bun.argv.includes("--headed");
const origin = Bun.argv.slice(2).find(argument => !argument.startsWith("--")) ?? "http://127.0.0.1:4175";
const url = new URL(origin);
url.searchParams.set("test", "1");
url.searchParams.set("stress", "1");
const round = (number: number) => Math.round(number * 1000) / 1000;
const browser = await chromium.launch({
    ...BROWSER_CONFIG.use.launchOptions,
    channel: BROWSER_CONFIG.use.channel,
    headless: !headed,
});

try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
        () => Boolean((window as StressWindow).__beatshooter), undefined, { timeout: 60_000 },
    );
    await page.getByRole("button", { name: /^Practice/ }).click();
    await page.waitForFunction(
        () => (window as StressWindow).__beatshooter!.snapshot().phase === "playing",
    );
    await page.waitForTimeout(WARMUP_MS);

    const environment = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        const info = adapter?.info;
        return {
            userAgent: navigator.userAgent,
            devicePixelRatio,
            crossOriginIsolated,
            gpu: info ? {
                vendor: info.vendor, architecture: info.architecture,
                device: info.device, description: info.description,
            } : null,
        };
    });
    const measurement = await page.evaluate((frames) => new Promise<{
        intervals: number[];
        counts: { enemies: number[]; projectiles: number[]; effects: number[]; entities: number[] };
        phases: string[];
        final: StressSnapshot;
    }>((resolve) => {
        const intervals: number[] = [];
        const counts = { enemies: [] as number[], projectiles: [] as number[], effects: [] as number[], entities: [] as number[] };
        const phases = new Set<string>();
        let previous: number | undefined;
        const frame = (time: number) => {
            const snapshot = (window as StressWindow).__beatshooter!.snapshot();
            if (previous !== undefined) {
                intervals.push(time - previous);
                counts.enemies.push(snapshot.combat.enemies);
                counts.projectiles.push(snapshot.combat.projectiles);
                counts.effects.push(snapshot.combat.effects);
                counts.entities.push(snapshot.entityCount);
                phases.add(snapshot.phase);
            }
            previous = time;
            if (intervals.length === frames) {
                resolve({ intervals, counts, phases: [...phases], final: snapshot });
            } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }), FRAMES);
    if (measurement.phases.length !== 1 || measurement.phases[0] !== "playing") {
        throw new Error(`Stress measurement did not remain playing: ${measurement.phases.join(", ")}`);
    }
    if (measurement.final.audioState !== "playing" || measurement.final.combat.health <= 0) {
        throw new Error("Stress session lost its active audio clock or player.");
    }
    if (Math.max(...measurement.counts.enemies) !== 200 ||
        Math.max(...measurement.counts.projectiles) > 500 ||
        Math.min(...measurement.counts.projectiles) < 1) {
        throw new Error("The expected 200-enemy/500-projectile refill fixture was not active.");
    }

    await mkdir("output/playwright", { recursive: true });
    const screenshot = "output/playwright/stress.png";
    await page.screenshot({ path: screenshot });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await page.waitForFunction(() => {
        const snapshot = (window as StressWindow).__beatshooter!.snapshot();
        return snapshot.phase === "menu" && snapshot.entityCount === 0 && snapshot.sounds === 0;
    });
    const cleanup = await page.evaluate(() => (window as StressWindow).__beatshooter!.snapshot());
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);

    const sorted = [...measurement.intervals].sort((a, b) => a - b);
    const percentile = (value: number) => sorted[Math.ceil(sorted.length * value) - 1]!;
    const mean = measurement.intervals.reduce((sum, value) => sum + value, 0) / FRAMES;
    const range = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });
    const report = {
        recordedAt: new Date().toISOString(),
        machine: {
            platform: platform(), release: release(), architecture: arch(),
            cpu: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length,
            memoryGiB: round(totalmem() / 1024 ** 3),
        },
        runtime: {
            bun: Bun.version, browser: `Chromium ${browser.version()}`,
            mode: headed ? "headed" : "headless", ...environment,
        },
        scenario: {
            url: url.href, viewport, warmupMilliseconds: WARMUP_MS, measuredFrames: FRAMES,
            refillBeforeEachFixedStep: { enemies: 200, projectiles: 500 },
            scope: "Real Shallot physics/rendering/audio and combat; read-only snapshot each animation frame.",
            note: "Counts are observed after collision/expiry and can be lower than the per-step refill target. Frame intervals include display pacing and snapshot overhead.",
        },
        frameIntervalsMilliseconds: {
            mean: round(mean), p50: round(percentile(0.5)), p95: round(percentile(0.95)),
            p99: round(percentile(0.99)), max: round(sorted.at(-1)!),
        },
        averageFramesPerSecond: round(1000 / mean),
        target60Fps: {
            frameBudgetMilliseconds: round(1000 / 60),
            timestampToleranceMilliseconds: TIMESTAMP_TOLERANCE_MS,
            met: mean <= 1000 / 60 + TIMESTAMP_TOLERANCE_MS &&
                percentile(0.95) <= 1000 / 60 + TIMESTAMP_TOLERANCE_MS,
        },
        observedCounts: {
            enemies: range(measurement.counts.enemies),
            projectiles: range(measurement.counts.projectiles),
            effects: range(measurement.counts.effects),
            sessionEntities: range(measurement.counts.entities),
        },
        cleanup: { phase: cleanup.phase, sessionEntities: cleanup.entityCount, sounds: cleanup.sounds },
        screenshot,
    };
    await writeFile("output/playwright/stress.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
} finally {
    await browser.close();
}
