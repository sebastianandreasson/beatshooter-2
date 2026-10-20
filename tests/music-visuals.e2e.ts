import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";
import type { MusicFloorInput } from "../src/music-visuals/floor";
import type { MusicalFrame } from "../src/rhythm/visual";

interface VisualSnapshot {
    phase: string;
    generation: number;
    position: number;
    combat: { score: number; health: number };
    bodyCount: number;
    visuals: {
        frame: MusicalFrame;
        intensity: number;
        motionAllowed: boolean;
        osReducedMotion: boolean;
        activeShards: number;
        activeRings: number;
        pendingBursts: number;
        feedback: number;
        acceptedEvents: number;
        suppressedEvents: number;
        poolCapacity: number;
        shaderStatus: "pending" | "ready" | "fallback";
        shaderError?: string;
        shaderInput: MusicFloorInput;
        particlePoses: { x: number; y: number; z: number }[];
    };
}

type InspectedWindow = Window & { __beatshooter?: { snapshot(): VisualSnapshot } };
const snapshot = (page: Page): Promise<VisualSnapshot> =>
    page.evaluate(() => (window as InspectedWindow).__beatshooter!.snapshot());

async function boot(page: Page, shaderStatus: "ready" | "fallback" = "ready"): Promise<void> {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as InspectedWindow).__beatshooter));
    await expect.poll(async () => (await snapshot(page)).visuals.shaderStatus, { timeout: 20_000 }).toBe(shaderStatus);
}

async function practice(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).position, { timeout: 10_000 }).toBeGreaterThan(0.05);
}

async function pause(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    // Let the pause's presentation/derived transforms publish before witnessing them.
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function freshRing(page: Page): Promise<void> {
    // These rings live for 0.75 s every 2 s in the dojo. Backoff polling can
    // repeatedly sample the empty part of that cycle; witness a fresh ring per frame.
    await page.waitForFunction(() => {
        const visuals = (window as InspectedWindow).__beatshooter!.snapshot().visuals;
        return visuals.activeRings > 0 && visuals.frame.barPhase < 0.1;
    }, undefined, { polling: "raf", timeout: 10_000 });
}

test.setTimeout(90_000);

test("actual floor uniforms follow music and particles freeze, resume, and clear on retry", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const initial = await snapshot(page);
    expect(initial.visuals.poolCapacity).toBe(256);
    await practice(page);
    const first = await snapshot(page);
    expect(first.visuals.frame.active).toBe(true);
    expect(first.visuals.frame.position).toBeCloseTo(first.position, 6);
    expect(first.visuals.shaderInput.beatCoordinate).toBe(first.visuals.frame.beatCoordinate);
    expect(first.visuals.shaderInput.barCoordinate).toBe(first.visuals.frame.barCoordinate);
    expect(first.visuals.shaderInput.intensity).toBeGreaterThan(0);
    expect(first.visuals.motionAllowed).toBe(true);
    await freshRing(page);
    await pause(page);
    const held = await snapshot(page);
    expect(held.visuals.acceptedEvents).toBeGreaterThan(0);
    expect(held.visuals.particlePoses.length).toBeGreaterThan(0);
    await page.waitForTimeout(450);
    const later = await snapshot(page);
    expect(later.position).toBe(held.position);
    expect(later.visuals.frame).toEqual(held.visuals.frame);
    expect(later.visuals.shaderInput).toEqual(held.visuals.shaderInput);
    expect(later.visuals.particlePoses).toEqual(held.visuals.particlePoses);
    expect(later.visuals.activeShards).toBe(held.visuals.activeShards);
    expect(later.visuals.pendingBursts).toBe(held.visuals.pendingBursts);

    await page.getByRole("button", { name: "Resume session" }).click();
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(held.position + 0.2);
    expect((await snapshot(page)).visuals.frame.beatCoordinate).toBeGreaterThan(first.visuals.frame.beatCoordinate);
    const screenshotPath = "output/playwright/music-floor-high.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("music-floor-and-combat", { path: screenshotPath, contentType: "image/png" });
    await pause(page);
    await page.getByRole("button", { name: "Restart session" }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.generation + 1);
    await expect.poll(async () => (await snapshot(page)).visuals.acceptedEvents).toBe(0);
    const fresh = await snapshot(page);
    expect(fresh.position).toBeLessThan(0);
    expect(fresh.visuals.activeShards).toBe(0);
    expect(fresh.visuals.activeRings).toBe(0);
    expect(fresh.visuals.pendingBursts).toBe(0);
    expect(fresh.visuals.feedback).toBe(0);
    expect(fresh.visuals.acceptedEvents).toBe(0);
    expect(fresh.visuals.poolCapacity).toBe(initial.visuals.poolCapacity);
    expect(fresh.bodyCount).toBe(initial.bodyCount);
    expect(fresh.combat.score).toBe(0);
    expect(errors).toEqual([]);
});

test("Off, Calm, Standard and reduced flashes update the renderer and persist independently of quality", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    await practice(page);
    await pause(page);
    const standard = (await snapshot(page)).visuals.intensity;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const intensity = page.getByRole("combobox", { name: "Visual effects", exact: true });
    await expect(intensity).toHaveValue("standard");
    await intensity.selectOption("calm");
    await expect.poll(async () => (await snapshot(page)).visuals.intensity).toBeLessThan(standard);
    expect((await snapshot(page)).visuals.intensity).toBeGreaterThan(0);
    await intensity.selectOption("off");
    await expect.poll(async () => (await snapshot(page)).visuals.shaderInput.intensity).toBe(0);
    await expect.poll(async () => (await snapshot(page)).visuals.activeShards).toBe(0);
    const off = await snapshot(page);
    expect(off.visuals.activeRings).toBe(0);
    expect(off.visuals.pendingBursts).toBe(0);
    expect(off.visuals.motionAllowed).toBe(false);
    expect(off.visuals.shaderInput.motionAllowed).toBe(false);

    await intensity.selectOption("standard");
    await expect.poll(async () => (await snapshot(page)).visuals.intensity).toBe(standard);
    await page.locator("#bs-reduced").check();
    await expect.poll(async () => (await snapshot(page)).visuals.intensity).toBeLessThan(standard);
    expect((await snapshot(page)).visuals.motionAllowed).toBe(false);
    await page.locator("#bs-reduced").uncheck();
    await intensity.selectOption("calm");
    await page.locator("#bs-graphics").selectOption("low");
    await expect.poll(async () => (await snapshot(page)).visuals.shaderInput.highQuality).toBe(false);
    const calm = (await snapshot(page)).visuals.intensity;
    await page.reload();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.getByRole("combobox", { name: "Visual effects", exact: true })).toHaveValue("calm");
    await expect(page.locator("#bs-graphics")).toHaveValue("low");
    await expect.poll(async () => (await snapshot(page)).visuals.intensity).toBe(calm);
    await page.getByRole("button", { name: "Reset settings", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Visual effects", exact: true })).toHaveValue("standard");
    await expect(page.locator("#bs-graphics")).toHaveValue("high");
});

test("live OS reduced-motion changes suppress travelling effects and survive retry", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await boot(page);
    await practice(page);
    const reduced = await snapshot(page);
    expect(reduced.visuals.osReducedMotion).toBe(true);
    expect(reduced.visuals.motionAllowed).toBe(false);
    expect(reduced.visuals.shaderInput.motionAllowed).toBe(false);
    expect(reduced.visuals.intensity).toBeLessThanOrEqual(0.18);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await snapshot(page)).visuals.motionAllowed).toBe(true);
    await expect.poll(async () => (await snapshot(page)).visuals.shaderInput.motionAllowed).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await snapshot(page)).visuals.motionAllowed).toBe(false);
    await page.keyboard.press("KeyR");
    await chooseStartingUpgrade(page);
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(reduced.generation + 1);
    await expect.poll(async () => (await snapshot(page)).visuals.activeShards).toBe(0);
    const restarted = await snapshot(page);
    expect(restarted.visuals.osReducedMotion).toBe(true);
    expect(restarted.visuals.motionAllowed).toBe(false);
    expect(restarted.visuals.activeShards).toBe(0);
    expect(restarted.visuals.pendingBursts).toBe(0);
});

test("floor shader compilation failure preserves the static arena and playable session", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        // Fail only the optional floor preflight. The engine's other shaders
        // and real GPU capabilities remain available to exercise recovery.
        const createShaderModule = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function (descriptor: GPUShaderModuleDescriptor) {
            return createShaderModule.call(this, descriptor.label === "Beatshooter floor validation"
                ? { ...descriptor, code: "deliberately invalid WGSL for the floor fallback test" }
                : descriptor);
        };
    });
    await boot(page, "fallback");
    expect((await snapshot(page)).visuals.shaderError?.length).toBeGreaterThan(0);
    await expect(page.locator("canvas")).toBeVisible();
    await practice(page);
    await expect.poll(async () => (await snapshot(page)).combat.score).toBeGreaterThan(0);
    const before = await snapshot(page);
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(before.position + 0.25);
    expect((await snapshot(page)).visuals.shaderStatus).toBe("fallback");
    const screenshotPath = "output/playwright/music-floor-fallback.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("static-floor-fallback", { path: screenshotPath, contentType: "image/png" });
    await pause(page);
    const held = await snapshot(page);
    await page.waitForTimeout(150);
    expect((await snapshot(page)).position).toBe(held.position);
    expect(errors).toEqual([]);
});

test.describe("calibration with Low graphics at DPR 2", () => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 1000, height: 700 } });

    test("rewinding visual calibration while paused clears old effects without moving music or combat", async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await boot(page);
        await page.getByRole("button", { name: "Open settings" }).click();
        await page.locator("#bs-graphics").selectOption("low");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await practice(page);
        await freshRing(page);
        const screenshotPath = "output/playwright/music-floor-low-dpr2.png";
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("music-floor-low-dpr2", { path: screenshotPath, contentType: "image/png" });
        await pause(page);
        const held = await snapshot(page);
        expect(held.visuals.activeRings).toBeGreaterThan(0);
        expect(held.visuals.shaderInput.highQuality).toBe(false);
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.locator("#bs-offset").press("Home");
        await expect(page.locator("#bs-offset")).toHaveValue("-250");
        await expect.poll(async () => (await snapshot(page)).visuals.frame.position)
            .toBeCloseTo(held.position - 0.25, 6);
        await expect.poll(async () => (await snapshot(page)).visuals.activeRings).toBe(0);
        const adjusted = await snapshot(page);
        expect(adjusted.position).toBe(held.position);
        expect(adjusted.combat).toEqual(held.combat);
        expect(adjusted.visuals.activeShards).toBe(0);
        expect(adjusted.visuals.pendingBursts).toBe(0);
        expect(adjusted.visuals.feedback).toBe(0);
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.getByRole("button", { name: "Resume session" }).click();
        await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(held.position + 0.3);
        const resumed = await snapshot(page);
        expect(resumed.visuals.frame.position).toBeCloseTo(resumed.position - 0.25, 6);
    });
});
