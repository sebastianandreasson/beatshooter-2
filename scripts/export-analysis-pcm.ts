/** Export exact local PCM; run tests/audio-analysis.ts and a dev server on4174 first. */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_CONFIG } from "@dylanebert/shallot/testing";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "output/audio-analysis/reference");
const localRoot = await realpath(resolve(root, "local-audio"));
const reportBytes = await readFile(resolve(root, "output/audio-analysis/report.json"));
const report = JSON.parse(reportBytes.toString()) as { results: {
    file: string; durationSeconds: number; beatCount: number; downbeatCount: number; chartId: string;
}[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (report.results?.[0]?.file !== "neon-circuit.wav" || report.results.length < 2) {
    throw new Error("Run tests/audio-analysis.ts first; its report must include the demo and local tracks.");
}
await mkdir(directory, { recursive: true });
const manifest = {
    schemaVersion: 1, complete: false, sourceReportSha256: hash(reportBytes),
    tracks: [] as {
        trackIndex: number; file: string; duration: number; sampleRate: number; sampleCount: number;
        path: string; sourceSha256: string; pcmSha256: string; browserAnalysisSha256: string;
    }[],
};
await writeFile(resolve(directory, "pcm.json"), JSON.stringify(manifest, null, 2));
const browser = await chromium.launch({
    ...BROWSER_CONFIG.use.launchOptions, channel: BROWSER_CONFIG.use.channel, headless: true,
});
try {
    const page = await browser.newPage();
    await page.route("**/pcm-reference", route => route.fulfill({
        contentType: "text/html", body: '<input type="file" id="audio">',
    }));
    await page.goto("http://127.0.0.1:4174/pcm-reference");
    for (let index = 1; index < report.results.length; index++) {
        const item = report.results[index]!;
        if (!item.file || /[/\\]/.test(item.file) || item.file === "." || item.file === "..") {
            throw new Error("Benchmark filenames must be plain local filenames.");
        }
        const filePath = await realpath(resolve(localRoot, item.file));
        if (!filePath.startsWith(localRoot + sep) || !(await stat(filePath)).isFile()) {
            throw new Error(`Track is outside local-audio: ${item.file}`);
        }
        const sourceSha256 = hash(await readFile(filePath));
        if (item.chartId.match(/^analyzed-([a-f0-9]{64})-/)?.[1] !== sourceSha256) {
            throw new Error(`Track changed since the benchmark: ${item.file}`);
        }
        const analysisBytes = await readFile(resolve(directory, `../track-${index}-beats.json`));
        const analysis = JSON.parse(analysisBytes.toString());
        if (analysis.beats?.length !== item.beatCount || analysis.downbeats?.length !== item.downbeatCount ||
            !Number.isFinite(analysis.duration) || Math.abs(analysis.duration - item.durationSeconds) > 0.002) {
            throw new Error(`Benchmark timing data does not match its report: ${item.file}`);
        }
        await page.locator("#audio").setInputFiles(filePath);
        const downloading = page.waitForEvent("download");
        const result = await page.evaluate(async () => {
            const modulePath = "/src/analysis/index.ts";
            const { prepareAnalysisAudio } = await import(modulePath);
            const file = document.querySelector<HTMLInputElement>("#audio")!.files![0]!;
            const context = new AudioContext();
            try {
                const audio = await context.decodeAudioData(await file.arrayBuffer());
                const pcm: Float32Array = await prepareAnalysisAudio(audio);
                const url = URL.createObjectURL(new Blob([pcm.buffer as ArrayBuffer]));
                const link = document.createElement("a");
                link.href = url; link.download = "analysis.f32"; link.click();
                return { duration: audio.duration, sampleRate: 22050, sampleCount: pcm.length, url };
            } finally { await context.close(); }
        });
        const path = `output/audio-analysis/reference/track-${index}.f32`;
        try {
            const download = await downloading;
            await download.saveAs(resolve(root, path));
        } finally {
            await page.evaluate(url => URL.revokeObjectURL(url), result.url);
        }
        const pcm = await readFile(resolve(root, path));
        if (Math.abs(result.duration - analysis.duration) > 0.002 ||
            Math.abs(result.sampleCount / result.sampleRate - result.duration) > 1 / 22050 ||
            pcm.length !== result.sampleCount * 4) {
            throw new Error(`Decoded PCM does not match the benchmark: ${item.file}`);
        }
        manifest.tracks.push({
            trackIndex: index, file: item.file, duration: result.duration,
            sampleRate: result.sampleRate, sampleCount: result.sampleCount, path,
            sourceSha256, pcmSha256: hash(pcm), browserAnalysisSha256: hash(analysisBytes),
        });
        console.log(`${item.file}: ${result.sampleCount} samples saved`);
    }
    manifest.complete = true;
    await writeFile(resolve(directory, "pcm.json"), JSON.stringify(manifest, null, 2));
} finally { await browser.close(); }
