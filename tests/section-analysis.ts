import { chooseStartingUpgrade } from "./starting-upgrade";
import { installUpgradeEntropy } from "./upgrade-entropy";
/** Local-only LinkSeg evaluation. Run a production preview separately, then:
 * bun tests/section-analysis.ts http://127.0.0.1:4187
 * Existing private test audio is read locally; no audio is uploaded.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform } from "node:os";
import { chromium } from "playwright";
import { BROWSER_CONFIG } from "@dylanebert/shallot/testing";
import type { BeatAnalysis } from "../src/analysis/types";
import { sectionAt, validateSections } from "../src/analysis/sections";
import { SECTION_STYLE } from "../src/ui/track-player";

type SectionWindow = Window & {
        __beatshooter?: {
            analysis(): BeatAnalysis | null;
            snapshot(): { phase: string; position: number; preview: { position: number; active: boolean };
                analysis?: { state: string; message: string }; chart: { id: string } };
        };
};
const origin = Bun.argv[2] ?? "http://127.0.0.1:4187";
const directory = "output/section-analysis";
await mkdir(directory, { recursive: true });
const inputs = ["public/tracks/neon-circuit.wav", ...(await readdir("local-audio"))
    .filter(file => /\.(mp3|wav|m4a|flac|ogg)$/i.test(file)).sort().map(file => `local-audio/${file}`)];
const browser = await chromium.launch({ ...BROWSER_CONFIG.use.launchOptions, channel: BROWSER_CONFIG.use.channel });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await installUpgradeEntropy(page);
const errors: string[] = [], unexpectedRequests: string[] = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && (url.origin !== new URL(origin).origin || request.method() !== "GET")) {
        unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
});
const state = () => page.evaluate(() => (window as SectionWindow).__beatshooter!.snapshot());
const phase = (value: string) => page.waitForFunction(value => (window as SectionWindow).__beatshooter!.snapshot().phase === value, value);
const analyze = async () => {
    await page.waitForFunction(() => ["ready", "error"].includes((window as SectionWindow).__beatshooter!.snapshot().analysis?.state ?? ""),
        undefined, { timeout: 60_000 });
    const result = await page.evaluate(() => (window as SectionWindow).__beatshooter!.analysis());
    if ((await state()).analysis?.state !== "ready" || !result) throw new Error("Analysis failed.");
    return result;
};
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const results: object[] = [];
try {
    await page.goto(`${origin}/?test=1`);
    await page.waitForFunction(() => !!(window as SectionWindow).__beatshooter, undefined, { timeout: 60_000 });
    const environment = await page.evaluate(async () => ({ userAgent: navigator.userAgent,
        gpu: (await navigator.gpu?.requestAdapter())?.info?.architecture, crossOriginIsolated }));
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    // A section-model failure must preserve the real beat chart and allow playing.
    await page.route("**/models/linkseg-7c.onnx", route => route.fulfill({ status: 404, body: "Missing test section model" }));
    await page.locator("#bs-audio-file").setInputFiles(resolve(inputs[0]!));
    const fallback = await analyze();
    assert(fallback.beats.length > 0 && !fallback.structure && fallback.sectionWarning, "Section fallback lost beat analysis.");
    assert(await page.locator('[data-action="start-local"]').isEnabled(), "Section fallback blocked gameplay.");
    await page.unroute("**/models/linkseg-7c.onnx");
    console.log("Missing-section-model recovery passed.");
    // Hold the optional model fetch, then cancel at that stage (not during Beat This).
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/models/linkseg-7c.onnx", async route => { await held; await route.abort().catch(() => {}); });
    await page.locator('[data-action="analyze-local"]').click();
    await page.waitForFunction(() => /Loading section model/.test((window as SectionWindow).__beatshooter!.snapshot().analysis?.message ?? ""),
        undefined, { timeout: 30_000 });
    await page.locator('[data-action="cancel-analysis"]').click();
    assert((await state()).analysis?.state === "idle", "Section-stage cancellation failed.");
    assert(await page.evaluate(() => (window as SectionWindow).__beatshooter!.analysis()) === null, "Cancelled results survived.");
    release();
    await page.unroute("**/models/linkseg-7c.onnx");
    console.log("Cancellation during section loading passed.");

    for (const [index, path] of inputs.entries()) {
        if (index) await page.getByRole("button", { name: "Import local audio", exact: true }).click();
        await page.locator("#bs-audio-file").setInputFiles(resolve(path));
        assert(await page.locator(".bs-section-preview").isHidden(), "Previous track sections remained after file replacement.");
        const analysis = await analyze();
        const structure = validateSections(analysis.structure, analysis.duration);
        assert(structure, `No valid sections for ${path}: ${analysis.sectionWarning}`);
        const prior = Bun.file(`output/audio-analysis/track-${index}-beats.json`);
        let beatParity: string = "baseline unavailable";
        if (await prior.exists()) {
            const old = await prior.json() as BeatAnalysis;
            if (old.duration === analysis.duration) {
                assert(JSON.stringify(old.beats) === JSON.stringify(analysis.beats) &&
                    JSON.stringify(old.downbeats) === JSON.stringify(analysis.downbeats), "Existing beat timestamps changed.");
                beatParity = "all beats and downbeats identical";
            }
        }
        assert(await page.locator(".bs-section-preview .bs-player-band").count() === structure!.sections.length,
            "Import preview does not show every section.");
        const owns = await page.evaluate(() => {
            const before = (window as SectionWindow).__beatshooter!.analysis()!.structure!.sections[0]!.label;
            (window as SectionWindow).__beatshooter!.analysis()!.structure!.sections[0]!.label = "silence";
            return (window as SectionWindow).__beatshooter!.analysis()!.structure!.sections[0]!.label === before;
        });
        assert(owns, "Inspection exposed mutable section metadata.");
        await page.locator("#bs-preview-section").selectOption("middle");
        await page.locator('[data-action="preview-local"]').click();
        await page.waitForFunction(() => (window as SectionWindow).__beatshooter!.snapshot().preview.active);
        const preview = await state();
        const section = sectionAt(structure!.sections, preview.preview.position)!;
        await page.waitForFunction(label => document.querySelector(".bs-section-preview .bs-player-section")?.textContent === label,
            SECTION_STYLE[section.label].name);
        await page.locator('[data-action="preview-local"]').click();
        await page.locator('[data-action="start-local"]').click();
        await chooseStartingUpgrade(page);
        await phase("playing");
        await page.waitForFunction(() => (window as SectionWindow).__beatshooter!.snapshot().position > 0);
        const id = (await state()).chart.id;
        assert(await page.locator(".bs-run-progress .bs-player-band").count() === structure!.sections.length,
            "HUD does not show every section.");
        const desktop = await page.locator(".bs-run-progress .bs-player-rail").boundingBox();
        assert(desktop && desktop.x >= 24 && desktop.x + desktop.width <= 1440 - 24 && desktop.height <= 8,
            "Desktop player must stay slim and inset from the viewport.");
        await page.screenshot({ path: `${directory}/track-${index}-desktop.png` });
        if (index === 1) {
            await page.setViewportSize({ width: 390, height: 844 });
            const mobile = await page.locator(".bs-run-progress .bs-player-rail").boundingBox();
            assert(mobile && mobile.x >= 16 && mobile.x + mobile.width <= 390 - 16 && mobile.height <= 8,
                "Mobile player must stay slim and inset from the viewport.");
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal overflow.");
            await page.screenshot({ path: `${directory}/player-narrow.png` });
            await page.setViewportSize({ width: 1440, height: 960 });
        }
        await page.keyboard.press("Escape");
        await phase("paused");
        const paused = await page.locator('.bs-run-progress progress').getAttribute("aria-valuetext");
        await page.waitForTimeout(150);
        assert(await page.locator('.bs-run-progress progress').getAttribute("aria-valuetext") === paused, "Paused player advanced.");
        await page.getByRole("button", { name: "Restart session", exact: true }).click();
        await chooseStartingUpgrade(page);
        await phase("playing");
        assert((await state()).chart.id === id, "Retry changed chart identity.");
        assert(await page.locator(".bs-run-progress .bs-player-band").count() === structure!.sections.length, "Retry lost sections.");
        await page.keyboard.press("Escape");
        await phase("paused");
        await page.getByRole("button", { name: "Return to menu", exact: true }).click();
        await phase("menu");
        const result = { file: path.split("/").at(-1), duration: analysis.duration,
            totalAnalysisMs: analysis.elapsedMs, sectionAnalysisMs: structure!.elapsedMs,
            sections: structure!.sections.length, labels: [...new Set(structure!.sections.map(s => s.label))],
            beatParity, previewPlayPauseRetry: "passed", structure };
        results.push(result);
        await writeFile(`${directory}/track-${index}.json`, JSON.stringify(analysis, null, 2) + "\n");
        console.log(JSON.stringify({ ...result, structure: undefined }));
    }
    // A non-analyzed session must not show the previous local track's predictions.
    await page.getByRole("button", { name: "Enter the arena", exact: true }).click();
    await chooseStartingUpgrade(page);
    await phase("playing");
    assert(await page.locator(".bs-run-progress .bs-player-band").count() === 0, "Bundled demo inherited local sections.");
    assert(errors.length === 0, `Uncaught errors: ${errors}`);
    assert(unexpectedRequests.length === 0, `Unexpected requests: ${unexpectedRequests}`);
    await writeFile(`${directory}/report.json`, JSON.stringify({ recordedAt: new Date().toISOString(),
        environment: { ...environment, browser: browser.version(), bun: Bun.version, cpu: cpus()[0]?.model, platform: platform() },
        missingSectionModel: "passed; detected beats remain playable", cancellationAtSectionStage: "passed",
        widths: [1440, 390], unexpectedRequests, pageErrors: errors, results,
        quality: "No human section annotations; this verifies inference, integration and timing preservation, not musical correctness.",
    }, null, 2) + "\n");
    console.log(`Report: ${directory}/report.json`);
} finally {
    await browser.close();
}
