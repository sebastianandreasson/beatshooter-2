import { expect, test, type Page } from "playwright/test";

interface Witness {
    snapshot(): {
        phase: string; generation: number; entityCount: number;
        sounds: number; pending: number; position: number;
    };
}
type WitnessWindow = Window & { __beatshooter?: Witness };
type DelayedFileWindow = Window & {
    __slowFileRequested?: boolean;
    __releaseSlowFile?: () => void;
};

test.setTimeout(75_000);

function captureErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return errors;
}

async function menu(page: Page): Promise<void> {
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as WitnessWindow).__beatshooter));
}

function wav(duration: number): Buffer {
    const samples = Math.floor(8000 * duration);
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

test("production responses preserve isolation and serve the manifest, audio, artwork, and entry assets", async ({ page, browser }, testInfo) => {
    const errors = captureErrors(page);
    const response = await page.goto("/?test=1");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
    await menu(page);
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect(page.locator(".bs-diagnostics")).toBeHidden();
    const manifestResponse = await page.request.get("/tracks/neon-circuit.json");
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json();
    expect(manifest.title).toBe("Neon Circuit");
    expect(manifest.beats.length).toBeGreaterThan(100);
    const audio = await page.request.get(new URL(manifest.audioUrl, response!.url()).href);
    expect(audio.ok()).toBe(true);
    expect((await audio.body()).subarray(0, 4).toString()).toBe("RIFF");
    for (const path of ["/icon.svg", "/tracks/neon-circuit.svg"]) {
        const asset = await page.request.get(path);
        expect(asset.status()).toBe(200);
        expect(await asset.text()).toContain("<svg");
    }
    const entry = await page.locator('script[type="module"][src]').getAttribute("src");
    expect(entry).toMatch(/^\/assets\/index-.*\.js$/);
    const entryResponse = await page.request.get(entry!);
    expect(entryResponse.ok()).toBe(true);
    expect((await entryResponse.body()).length).toBeGreaterThan(1000);
    const hostHeaders = await page.request.get("/_headers");
    expect(hostHeaders.ok()).toBe(true);
    expect(await hostHeaders.text()).toContain("Cross-Origin-Embedder-Policy: require-corp");
    const environment = {
        browser: browser.version(),
        ...await page.evaluate(() => ({
            userAgent: navigator.userAgent, devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight },
            isolated: crossOriginIsolated,
        })),
    };
    await testInfo.attach("release-browser-environment", {
        body: JSON.stringify(environment, null, 2), contentType: "application/json",
    });
    console.log("Release browser environment:", JSON.stringify(environment));
    expect(errors).toEqual([]);
});

test("missing WebGPU replaces loading with an actionable support message", async ({ page }) => {
    const errors = captureErrors(page);
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    });
    await page.goto("/");
    const failure = page.locator("[data-shallot-loading]");
    await expect(failure).toBeVisible({ timeout: 20_000 });
    await expect(failure).toContainText("WebGPU not supported", { timeout: 20_000 });
    const support = failure.getByRole("link", { name: "WebGPU not supported." });
    await expect(support).toHaveAttribute("href", "https://caniuse.com/webgpu");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toHaveCount(0);
    // The engine reports its handled startup failure by rejecting runApp.
    // No unrelated page error is allowed in this intentionally unsupported case.
    expect(errors.every((message) => /WebGPU unavailable|navigator\.gpu is missing/.test(message))).toBe(true);
});

test("cancelling a delayed demo load cannot later start its audio or gameplay", async ({ page }) => {
    const errors = captureErrors(page);
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/tracks/neon-circuit.wav", async (route) => {
        requested();
        await gate;
        // Cancellation aborts this fetch before the delayed network response.
        await route.continue().catch(() => undefined);
    });
    try {
        await page.goto("/?test=1");
        await menu(page);
        await page.getByRole("button", { name: "Enter the arena" }).click();
        await started;
        await expect(page.locator('[data-screen="loading"]')).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await menu(page);
        const cancelled = await page.evaluate(() => (window as WitnessWindow).__beatshooter!.snapshot());
        release();
        await page.waitForTimeout(500);
        const settled = await page.evaluate(() => (window as WitnessWindow).__beatshooter!.snapshot());
        expect(settled.phase).toBe("menu");
        expect(settled.generation).toBe(cancelled.generation);
        expect(settled.entityCount).toBe(0);
        expect(settled.sounds).toBe(0);
        expect(settled.pending).toBe(0);
        await expect(page.locator('[data-value="menu-error"]')).toBeHidden();
        await page.getByRole("button", { name: "Practice", exact: true }).click();
        await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
        expect(errors).toEqual([]);
    } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
    }
});

test("a newer local selection supersedes a delayed calibration read without reviving it", async ({ page }) => {
    const errors = captureErrors(page);
    // Delay file I/O, not gameplay or audio clocks. The UI stays interactive
    // during calibration loading, so another actual file selection can supersede it.
    await page.addInitScript(() => {
        const nativeRead = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            const bytes = await nativeRead.call(this);
            if (this.name === "slow-selection.wav") {
                (window as DelayedFileWindow).__slowFileRequested = true;
                await new Promise<void>((resolve) => {
                    (window as DelayedFileWindow).__releaseSlowFile = resolve;
                });
            }
            return bytes;
        };
    });
    await page.goto("/?test=1");
    await menu(page);
    await page.getByRole("button", { name: "Import local audio" }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "slow-selection.wav", mimeType: "audio/wav", buffer: wav(5),
    });
    await page.getByRole("button", { name: "Preview with metronome" }).click();
    await page.waitForFunction(() => (window as DelayedFileWindow).__slowFileRequested);
    await page.locator("#bs-audio-file").setInputFiles({
        name: "new-selection.wav", mimeType: "audio/wav", buffer: wav(1.2),
    });
    await page.getByRole("button", { name: "Play this track" }).click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect(page.locator('[data-value="track-title"]')).toHaveText("new-selection");
    await page.evaluate(() => (window as DelayedFileWindow).__releaseSlowFile!());
    await expect(page.locator('[data-screen="results"]')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[data-value="result-title"]')).toHaveText("You held your ground.");
    const result = await page.evaluate(() => (window as WitnessWindow).__beatshooter!.snapshot());
    expect(result.position).toBeCloseTo(1.2, 1);
    expect(result.sounds).toBe(0);
    expect(result.pending).toBe(0);
    expect(errors).toEqual([]);
});

test("focus loss during loading opens a paused session until an explicit resume", async ({ page }) => {
    const errors = captureErrors(page);
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/tracks/neon-circuit.wav", async (route) => {
        requested();
        await gate;
        await route.continue();
    });
    try {
        await page.goto("/?test=1");
        await menu(page);
        await page.getByRole("button", { name: "Enter the arena" }).click();
        await started;
        await expect(page.locator('[data-screen="loading"]')).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        release();
        await expect(page.locator('[data-screen="paused"]')).toBeVisible({ timeout: 20_000 });
        const paused = await page.evaluate(() => (window as WitnessWindow).__beatshooter!.snapshot());
        expect(paused.pending).toBe(0);
        await page.waitForTimeout(500);
        const later = await page.evaluate(() => (window as WitnessWindow).__beatshooter!.snapshot());
        expect(later.position).toBe(paused.position);
        expect(later.phase).toBe("paused");
        await page.getByRole("button", { name: "Resume session" }).click();
        await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
        expect(errors).toEqual([]);
    } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
    }
});

test("a missing bundled audio file gives a useful recovery path without an uncaught error", async ({ page }) => {
    const errors = captureErrors(page);
    await page.route("**/tracks/neon-circuit.wav", (route) => route.fulfill({
        status: 404, contentType: "text/plain", body: "Controlled missing audio",
    }));
    await page.goto("/?test=1");
    await menu(page);
    await page.getByRole("button", { name: "Enter the arena" }).click();
    await expect(page.locator('[data-value="menu-error"]')).toContainText("HTTP 404");
    await menu(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    expect(errors).toEqual([]);
});
