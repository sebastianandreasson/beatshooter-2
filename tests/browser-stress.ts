import { chooseStartingUpgrade } from "./starting-upgrade";
/**
 * Explicit rendering/physics benchmark; not discovered as a unit/browser test.
 * Serve an existing production build first; this script never rebuilds it.
 * Run: bun tests/browser-stress.ts [http://127.0.0.1:4175] [--headed] [--upgraded]
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
    enemyHealthbars: number;
    entityCount: number;
    sounds: number;
    projectiles: { waitingForBounce: boolean; hitEnemyIds: number[] }[];
    playerStats: {
        effective: { projectileCount: number; barrageCount: number; bounces: number };
        metrics: { shotsFired: number; hits: number; totalDamageDealt: number };
    };
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
const upgraded = Bun.argv.includes("--upgraded") || url.searchParams.get("upgradeStress") === "1";
if (upgraded) url.searchParams.set("upgradeStress", "1");
const artifactName = upgraded ? "stress-upgraded" : "stress";
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
    await chooseStartingUpgrade(page);
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
        counts: {
            enemies: number[]; healthbars: number[]; projectiles: number[];
            waitingForBounce: number[]; hitMultipleEnemies: number[]; effects: number[]; entities: number[];
        };
        phases: string[];
        final: StressSnapshot;
    }>((resolve) => {
        const intervals: number[] = [];
        const counts = {
            enemies: [] as number[], healthbars: [] as number[], projectiles: [] as number[],
            waitingForBounce: [] as number[], hitMultipleEnemies: [] as number[],
            effects: [] as number[], entities: [] as number[],
        };
        const phases = new Set<string>();
        let previous: number | undefined;
        const frame = (time: number) => {
            const snapshot = (window as StressWindow).__beatshooter!.snapshot();
            if (previous !== undefined) {
                intervals.push(time - previous);
                counts.enemies.push(snapshot.combat.enemies);
                counts.healthbars.push(snapshot.enemyHealthbars);
                counts.projectiles.push(snapshot.combat.projectiles);
                counts.waitingForBounce.push(snapshot.projectiles.filter(shot => shot.waitingForBounce).length);
                counts.hitMultipleEnemies.push(snapshot.projectiles.filter(shot => shot.hitEnemyIds.length > 1).length);
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
    if (measurement.counts.healthbars.some((count, index) => count !== measurement.counts.enemies[index])) {
        throw new Error("The stress fixture must render one health bar per live enemy.");
    }
    if (upgraded) {
        const stats = measurement.final.playerStats.effective;
        if (stats.projectileCount !== 7 || stats.barrageCount !== 24 || stats.bounces !== 5
            || Math.max(...measurement.counts.waitingForBounce) < 1
            || Math.max(...measurement.counts.hitMultipleEnemies) < 1) {
            throw new Error("The upgraded fixture must exercise maximum stats and real beat-gated ricochets.");
        }
    }

    await mkdir("output/playwright", { recursive: true });
    const screenshot = `output/playwright/${artifactName}.png`;
    await page.screenshot({ path: screenshot });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await page.waitForFunction(() => {
        const snapshot = (window as StressWindow).__beatshooter!.snapshot();
        // DOM ownership clears in the following presentation pass, after the
        // synchronous session/entity teardown triggered by the menu button.
        return snapshot.phase === "menu" && snapshot.entityCount === 0
            && snapshot.enemyHealthbars === 0 && snapshot.sounds === 0;
    });
    const cleanup = await page.evaluate(() => (window as StressWindow).__beatshooter!.snapshot());
    if (cleanup.enemyHealthbars !== 0) throw new Error("Enemy health bars survived session cleanup.");
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
            mode: upgraded ? "upgraded" : "baseline",
            url: url.href, viewport, warmupMilliseconds: WARMUP_MS, measuredFrames: FRAMES,
            refillBeforeEachFixedStep: { enemies: 200, projectiles: 500 },
            playerStats: measurement.final.playerStats.effective,
            playerDamageMetrics: measurement.final.playerStats.metrics,
            scope: "Real Shallot physics/rendering/audio and combat; read-only snapshot each animation frame.",
            note: "Counts are observed after collision/expiry and can be lower than the per-step refill target. Frame intervals include display pacing and snapshot overhead. The fixture refills individual projectiles independently of beat-fired fans and barrages, so it measures sustained density rather than a normal-play firing rate.",
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
            healthbars: range(measurement.counts.healthbars),
            projectiles: range(measurement.counts.projectiles),
            waitingForBounce: range(measurement.counts.waitingForBounce),
            hitMultipleEnemies: range(measurement.counts.hitMultipleEnemies),
            effects: range(measurement.counts.effects),
            sessionEntities: range(measurement.counts.entities),
        },
        cleanup: { phase: cleanup.phase, sessionEntities: cleanup.entityCount, healthbars: cleanup.enemyHealthbars, sounds: cleanup.sounds },
        screenshot,
    };
    await writeFile(`output/playwright/${artifactName}.json`, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
} finally {
    await browser.close();
}
