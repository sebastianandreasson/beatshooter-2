import { expect, test, type Page } from "playwright/test";
import { ANALYZER_VERSION, type BeatAnalysis } from "../src/analysis/types";
import { SECTION_ANALYZER_VERSION } from "../src/analysis/sections";

interface SectionSnapshot {
    phase: string;
    generation: number;
    position: number;
    bodyCount: number;
    analysis?: { state: string };
    chart: { beatCount: number; downbeatCount: number };
    player: {
        position: { x: number; z: number };
        target: { x: number; z: number };
        velocity: { x: number; z: number };
        bodyY: number;
    };
    sectionEffects: {
        active: boolean;
        sectionIndex: number;
        label?: string;
        startTime: number;
        endTime: number;
        progress: number;
        roll: number;
        zoom: number;
        mapRoll: number;
        palette: unknown;
        motionAllowed: boolean;
        map: {
            position: { x: number; y: number; z: number };
            rotation: { x: number; y: number; z: number; w: number };
        };
        camera: {
            position: { x: number; y: number; z: number };
            rotation: { x: number; y: number; z: number; w: number };
            size: number;
            clearColor: number;
        };
    };
}

interface MotionSample {
    position: number;
    progress: number;
    mapRoll: number;
    velocityX: number;
    cameraRotation: SectionSnapshot["sectionEffects"]["camera"]["rotation"];
    cameraSize: number;
    screenVelocity: [number, number] | null;
    speed: number;
}

type InspectedWindow = Window & {
    __beatshooter: {
        snapshot(): SectionSnapshot;
        project(point: [number, number, number]): [number, number] | null;
        analysis(): BeatAnalysis | null;
    };
    __sectionMotion?: MotionSample[];
};

const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

function wav(duration: number): Buffer {
    const sampleRate = 8_000, samples = duration * sampleRate;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(sampleRate, 24);
    bytes.writeUInt32LE(sampleRate * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

async function boot(page: Page, mode: "standard" | "off" | "reduced" = "standard") {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
    // Replace only inference at the existing worker/network seam. Decoding,
    // PCM transfer, chart validation, section validation, selection, and real
    // Web Audio playback all use the shipped application. No game state is set.
    await page.route(/\/(?:assets\/worker-[^/]+\.js|src\/analysis\/worker\.ts)(?:\?.*)?$/, route =>
        route.fulfill({
            contentType: "application/javascript",
            // A module worker in this isolated page must retain the same
            // embedder policy as the production worker response.
            headers: { "Cross-Origin-Embedder-Policy": "require-corp" },
            body: `
                self.onmessage = ({ data }) => {
                    if (data.type !== "analyze") return;
                    const { duration, pcm } = data;
                    if (!(pcm instanceof Float32Array) || duration !== 12
                        || Math.abs(pcm.length - duration * 22050) > 1) {
                        self.postMessage({ type: "error", message: "Invalid decoded section fixture." });
                        return;
                    }
                    const beats = Array.from({ length: duration * 2 }, (_, index) => index * .5);
                    self.postMessage({ type: "result", result: {
                        schemaVersion: 1, analyzerVersion: ${JSON.stringify(ANALYZER_VERSION)},
                        duration, beats, downbeats: beats.filter((_, index) => index % 4 === 0),
                        elapsedMs: 1, backend: "wasm",
                        structure: {
                            version: 1, analyzerVersion: ${JSON.stringify(SECTION_ANALYZER_VERSION)},
                            duration, elapsedMs: 1, backend: "wasm",
                            sections: [
                                { start: 0, end: 2, label: "intro" },
                                { start: 2, end: 7, label: "chorus" },
                                { start: 7, end: duration, label: "outro" },
                            ],
                        },
                    } });
                };
            `,
        }));
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
    if (mode === "off") {
        await page.getByRole("button", { name: "Open settings" }).click();
        await page.getByRole("combobox", { name: "Visual effects", exact: true }).selectOption("off");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
    }
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "section-transition-fixture.wav", mimeType: "audio/wav", buffer: wav(12),
    });
    await expect.poll(async () => (await snapshot(page)).analysis?.state).toBe("ready");
    await expect(page.locator(".bs-section-preview .bs-player-band")).toHaveCount(3);
    await page.locator('[data-action="start-local"]').click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > 0.1 && state.position < 1.5;
    }, undefined, { polling: "raf", timeout: 10_000 });
    return snapshot(page);
}

async function atProgress(page: Page, progress: number) {
    const value = await page.waitForFunction(progress => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.sectionEffects.sectionIndex === 1
            && state.sectionEffects.progress >= progress
            && state.sectionEffects.progress < progress + 0.12 ? state : false;
    }, progress, { polling: "raf", timeout: 8_000 });
    return await value.jsonValue() as SectionSnapshot;
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function pointerError(page: Page, x: number, y: number) {
    return page.evaluate(({ x, y }) => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const { target } = api.snapshot().player;
        const projected = api.project([target.x, 0.55, target.z]);
        const rect = document.querySelector("canvas")!.getBoundingClientRect();
        return projected ? Math.hypot(projected[0] + rect.left - x, projected[1] + rect.top - y) : Infinity;
    }, { x, y });
}

test.setTimeout(60_000);

test("a detected section tumbles the decorative floor while camera, controls, pause, and replay stay stable", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const baseline = await boot(page);
    expect(baseline.chart.beatCount).toBe(24);
    expect(baseline.chart.downbeatCount).toBe(6);
    expect(baseline.sectionEffects.sectionIndex).toBe(0);
    expect(baseline.sectionEffects.active).toBe(false);
    expect(baseline.sectionEffects.roll).toBe(0);
    expect(baseline.sectionEffects.zoom).toBe(1);
    expect(baseline.sectionEffects.mapRoll).toBe(0);
    expect(baseline.sectionEffects.camera.size).toBe(17);

    const beginning = await atProgress(page, 0.08);
    expect(beginning.sectionEffects.active).toBe(true);
    expect(beginning.sectionEffects.label).toBe("chorus");
    expect(beginning.sectionEffects.startTime).toBe(2);
    expect(beginning.sectionEffects.endTime).toBe(4);
    expect(beginning.sectionEffects.progress).toBeCloseTo((beginning.position - 2) / 2, 5);
    expect(beginning.sectionEffects.roll).toBe(0);
    expect(beginning.sectionEffects.zoom).toBe(1);
    expect(beginning.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(beginning.sectionEffects.camera.size).toBe(17);
    expect(beginning.sectionEffects.mapRoll).not.toBe(0);
    expect(beginning.sectionEffects.map.rotation).not.toEqual(baseline.sectionEffects.map.rotation);
    expect(beginning.sectionEffects.palette).not.toEqual(baseline.sectionEffects.palette);
    await expect(page.locator(".bs-run-progress .bs-player-section")).toHaveText("Chorus");

    // Read-only per-frame samples witness real keyboard movement during the
    // floor tumble. The camera and screen-space controls stay upright.
    await page.evaluate(() => {
        const target = window as unknown as InspectedWindow;
        target.__sectionMotion = [];
        const sample = () => {
            const state = target.__beatshooter.snapshot();
            if (!["playing", "paused"].includes(state.phase) || state.position >= 4) return;
            const player = state.player.position, velocity = state.player.velocity;
            const from = target.__beatshooter.project([player.x, 0.55, player.z]);
            const to = target.__beatshooter.project([player.x + velocity.x * 0.1, 0.55, player.z + velocity.z * 0.1]);
            target.__sectionMotion!.push({
                position: state.position, progress: state.sectionEffects.progress,
                mapRoll: state.sectionEffects.mapRoll, velocityX: velocity.x,
                cameraRotation: state.sectionEffects.camera.rotation,
                cameraSize: state.sectionEffects.camera.size,
                screenVelocity: from && to ? [to[0] - from[0], to[1] - from[1]] : null,
                speed: Math.hypot(velocity.x, velocity.z),
            });
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    await atProgress(page, 0.32);
    await page.keyboard.down("KeyD");
    const inverted = await atProgress(page, 0.48);
    expect(Math.abs(Math.abs(inverted.sectionEffects.mapRoll) - Math.PI)).toBeLessThan(0.6);
    expect(inverted.sectionEffects.map.position.y).toBeLessThan(baseline.sectionEffects.map.position.y);
    expect(inverted.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(inverted.sectionEffects.camera.size).toBe(17);
    expect(inverted.sectionEffects.roll).toBe(0);
    expect(inverted.sectionEffects.zoom).toBe(1);
    expect(inverted.player.bodyY).toBeCloseTo(0.55, 4);
    await page.keyboard.up("KeyD");
    const motion = await page.evaluate(() => (window as unknown as InspectedWindow).__sectionMotion!);
    const movingInverted = motion.filter(frame =>
        Math.abs(Math.abs(frame.mapRoll) - Math.PI) < 0.6 && frame.speed > 2 && frame.screenVelocity);
    expect(movingInverted.length).toBeGreaterThan(2);
    expect(movingInverted.every(frame => frame.screenVelocity![0] > 0)).toBe(true);
    expect(movingInverted.every(frame => frame.velocityX > 0)).toBe(true);
    const screenshotPath = "output/playwright/section-floor-tumble.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("section-floor-tumble", { path: screenshotPath, contentType: "image/png" });
    await pause(page);
    const held = await snapshot(page);
    expect(held.sectionEffects.active).toBe(true);
    await page.waitForTimeout(250);
    const frozen = await snapshot(page);
    expect(frozen.position).toBe(held.position);
    expect(frozen.sectionEffects).toEqual(held.sectionEffects);
    expect(frozen.player.position).toEqual(held.player.position);

    await page.mouse.move(830, 330);
    await expect.poll(() => pointerError(page, 830, 330)).toBeLessThan(2);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > 4.1 && state.position < 6 && !state.sectionEffects.active;
    }, undefined, { polling: "raf", timeout: 5_000 });
    const settled = await snapshot(page);
    const allMotion = await page.evaluate(() => (window as unknown as InspectedWindow).__sectionMotion!);
    expect(allMotion.some(frame => frame.progress > 0.9)).toBe(true);
    for (const frame of allMotion) {
        expect(frame.cameraRotation).toEqual(baseline.sectionEffects.camera.rotation);
        expect(frame.cameraSize).toBe(17);
    }
    expect(settled.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(settled.sectionEffects.camera.size).toBe(17);
    expect(settled.sectionEffects.roll).toBe(0);
    expect(settled.sectionEffects.zoom).toBe(1);
    expect(settled.sectionEffects.mapRoll).toBe(0);
    expect(settled.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(settled.sectionEffects.camera.clearColor).not.toBe(baseline.sectionEffects.camera.clearColor);

    await pause(page);
    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(baseline.generation + 1);
    const restarted = await snapshot(page);
    expect(restarted.position).toBeLessThan(0);
    expect(restarted.sectionEffects.active).toBe(false);
    expect(restarted.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(restarted.sectionEffects.camera.size).toBe(17);
    expect(restarted.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    await atProgress(page, 0.2);
    await pause(page);
    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).sectionEffects.active).toBe(false);
    const menu = await snapshot(page);
    expect(menu.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(menu.sectionEffects.camera.size).toBe(17);
    expect(menu.sectionEffects.camera.clearColor).toBe(0x090f15);
    expect(menu.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(menu.bodyCount).toBe(baseline.bodyCount);
    expect(errors).toEqual([]);
});

for (const mode of ["off", "reduced"] as const) {
    test(`${mode} motion keeps section palette changes without floor or camera travel`, async ({ page }, testInfo) => {
        const baseline = await boot(page, mode);
        const middle = await atProgress(page, 0.5);
        expect(middle.sectionEffects.label).toBe("chorus");
        expect(middle.sectionEffects.motionAllowed).toBe(false);
        expect(middle.sectionEffects.roll).toBe(0);
        expect(middle.sectionEffects.zoom).toBe(1);
        expect(middle.sectionEffects.mapRoll).toBe(0);
        expect(middle.sectionEffects.map).toEqual(baseline.sectionEffects.map);
        expect(middle.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
        expect(middle.sectionEffects.camera.size).toBe(17);
        expect(middle.sectionEffects.camera.clearColor).not.toBe(baseline.sectionEffects.camera.clearColor);
        expect(middle.sectionEffects.palette).not.toEqual(baseline.sectionEffects.palette);
        const screenshotPath = `output/playwright/section-map-${mode}.png`;
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`section-map-${mode}`, { path: screenshotPath, contentType: "image/png" });
        await pause(page);
        const held = await snapshot(page);
        await page.waitForTimeout(200);
        expect((await snapshot(page)).sectionEffects).toEqual(held.sectionEffects);
    });
}
