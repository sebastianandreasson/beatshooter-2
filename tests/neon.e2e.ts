import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";

interface NeonSnapshot {
    phase: string;
    generation: number;
    position: number;
    combat: { kills: number; score: number };
    enemies: { id: number; x: number; z: number }[];
    player: { position: { x: number; z: number } };
    neon: {
        status: "pending" | "ready" | "fallback";
        error?: string;
        frame: {
            enabled: boolean;
            bloom: number;
            threshold: number;
            knee: number;
            chromatic: number;
            vignette: number;
            reducedDetail: boolean;
        };
        passes: number;
        dimensions: { width: number; height: number; bloomWidth: number; bloomHeight: number };
    };
    neonTrails: { visibleCount: number; capacity: number; samples: unknown[] };
}

type InspectedWindow = Window & {
    __beatshooter: {
        snapshot(): NeonSnapshot;
        project(point: [number, number, number]): [number, number] | null;
    };
};

const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

async function boot(page: Page) {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
}

async function practice(page: Page) {
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > 0.1 && state.neon.status === "ready"
            && state.neon.frame.enabled && state.neon.passes > 0;
    }, undefined, { polling: "raf", timeout: 15_000 });
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function freshTrail(page: Page) {
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.phase === "playing"
            && state.neonTrails.visibleCount > 0 && state.neonTrails.samples.length > 0;
    }, undefined, { polling: "raf", timeout: 5_000 });
}

async function ordinaryKill(page: Page) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const witness = await page.evaluate(() => {
            const api = (window as unknown as InspectedWindow).__beatshooter;
            const state = api.snapshot(), player = state.player.position;
            const enemy = [...state.enemies].sort((a, b) =>
                Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))[0];
            const pixel = enemy && api.project([enemy.x, 0.55, enemy.z]);
            const bounds = document.querySelector("canvas")!.getBoundingClientRect();
            return { kills: state.combat.kills, pointer: pixel ? [pixel[0] + bounds.left, pixel[1] + bounds.top] : null };
        });
        if (witness.kills > 0) return;
        if (witness.pointer) await page.mouse.move(witness.pointer[0]!, witness.pointer[1]!);
        await page.waitForTimeout(35);
    }
    throw new Error("Ordinary aim did not produce a kill for the neon presentation capture.");
}

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(60_000);

test("real bloom and projectile trails follow music, freeze on pause, and reuse their pool on retry", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await boot(page);
    await practice(page);
    const normal = await snapshot(page);
    expect(normal.neon.status).toBe("ready");
    expect(normal.neon.error).toBeUndefined();
    expect(normal.neon.frame.bloom).toBeGreaterThan(0);
    expect(normal.neon.frame.chromatic).toBe(0);
    expect(normal.neon.frame.vignette).toBeGreaterThan(0);
    expect(normal.neon.passes).toBeGreaterThan(0);
    expect(normal.neon.dimensions.bloomWidth).toBeGreaterThan(0);
    expect(normal.neon.dimensions.bloomHeight).toBeGreaterThan(0);
    expect(normal.neonTrails.capacity).toBe(192);

    await ordinaryKill(page);
    await freshTrail(page);
    const screenshotPath = "output/playwright/neon-combat-glow.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("neon-combat-glow", { path: screenshotPath, contentType: "image/png" });
    await freshTrail(page);
    await pause(page);
    const held = await snapshot(page);
    expect(held.neonTrails.visibleCount).toBeGreaterThan(0);
    expect(held.neonTrails.visibleCount).toBeLessThanOrEqual(held.neonTrails.capacity);
    expect(held.neonTrails.samples.length).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    const frozen = await snapshot(page);
    expect(frozen.position).toBe(held.position);
    expect(frozen.neon.frame).toEqual(held.neon.frame);
    expect(frozen.neonTrails).toEqual(held.neonTrails);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(held.position + 0.25);
    await freshTrail(page);
    expect((await snapshot(page)).neonTrails.capacity).toBe(held.neonTrails.capacity);

    await pause(page);
    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.generation + 1);
    await expect.poll(async () => (await snapshot(page)).neonTrails.visibleCount).toBe(0);
    const restarted = await snapshot(page);
    expect(restarted.position).toBeLessThanOrEqual(0);
    expect(restarted.neonTrails.visibleCount).toBe(0);
    expect(restarted.neonTrails.capacity).toBe(held.neonTrails.capacity);
    expect(restarted.neon.status).toBe("ready");
    expect(restarted.neon.dimensions).toEqual(held.neon.dimensions);
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await freshTrail(page);
    expect(errors).toEqual([]);
});

test("Calm weakens bloom, Off bypasses processing, and reduced motion keeps a steady glow without trails", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await boot(page);
    await practice(page);
    await freshTrail(page);
    await pause(page);
    const standard = await snapshot(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const intensity = page.getByRole("combobox", { name: "Visual effects", exact: true });
    await intensity.selectOption("calm");
    await expect.poll(async () => (await snapshot(page)).neon.frame.bloom).toBeLessThan(standard.neon.frame.bloom);
    const calm = await snapshot(page);
    expect(calm.position).toBe(standard.position);
    expect(calm.neon.frame.bloom).toBeGreaterThan(0);
    expect(calm.neon.frame.enabled).toBe(true);
    await intensity.selectOption("off");
    await expect.poll(async () => (await snapshot(page)).neon.passes).toBe(0);
    await expect.poll(async () => (await snapshot(page)).neonTrails.visibleCount).toBe(0);
    const off = await snapshot(page);
    expect(off.neon.frame.enabled).toBe(false);
    expect(off.neon.frame.chromatic).toBe(0);
    expect(off.position).toBe(standard.position);
    expect(off.neonTrails.capacity).toBe(standard.neonTrails.capacity);

    await intensity.selectOption("standard");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await snapshot(page)).neonTrails.visibleCount).toBe(0);
    await expect.poll(async () => (await snapshot(page)).neon.frame.enabled).toBe(true);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    const reduced = await snapshot(page);
    expect(reduced.neon.frame.bloom).toBeGreaterThan(0);
    expect(reduced.neon.frame.chromatic).toBe(0);
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(reduced.position + 0.3);
    const later = await snapshot(page);
    expect(later.neon.frame.bloom).toBe(reduced.neon.frame.bloom);
    expect(later.neon.frame.chromatic).toBe(0);
    expect(later.neonTrails.visibleCount).toBe(0);
    const screenshotPath = "output/playwright/neon-reduced-motion.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("neon-reduced-motion", { path: screenshotPath, contentType: "image/png" });
    expect(errors).toEqual([]);
});

test("Low graphics uses fewer passes and smaller bloom targets that rebuild correctly after resize", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await boot(page);
    await practice(page);
    await pause(page);
    const high = await snapshot(page);
    expect(high.neon.frame.reducedDetail).toBe(false);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#bs-graphics").selectOption("low");
    await expect.poll(async () => (await snapshot(page)).neon.frame.reducedDetail).toBe(true);
    await expect.poll(async () => (await snapshot(page)).neon.dimensions.bloomWidth)
        .toBeLessThan(high.neon.dimensions.bloomWidth);
    const low = await snapshot(page);
    expect(low.neon.passes).toBeGreaterThan(0);
    expect(low.neon.passes).toBeLessThan(high.neon.passes);
    expect(low.neon.dimensions.bloomHeight).toBeLessThan(high.neon.dimensions.bloomHeight);
    expect(low.neonTrails.capacity).toBe(high.neonTrails.capacity);
    await page.setViewportSize({ width: 960, height: 640 });
    await expect.poll(async () => {
        const dimensions = (await snapshot(page)).neon.dimensions;
        return dimensions.width / dimensions.height;
    }).toBeCloseTo(1.5, 2);
    const resized = await snapshot(page);
    expect(resized.neon.status).toBe("ready");
    expect(resized.neon.dimensions.bloomWidth).toBeLessThan(low.neon.dimensions.bloomWidth);
    expect(resized.position).toBe(high.position);
    await page.locator("#bs-graphics").selectOption("high");
    await expect.poll(async () => (await snapshot(page)).neon.frame.reducedDetail).toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await snapshot(page)).neon.dimensions).toEqual(high.neon.dimensions);
    const restored = await snapshot(page);
    expect(restored.neon.passes).toBe(high.neon.passes);
    expect(restored.neonTrails.capacity).toBe(high.neonTrails.capacity);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(high.position + 0.2);
    const screenshotPath = "output/playwright/neon-resize-restored.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("neon-resize-restored", { path: screenshotPath, contentType: "image/png" });
    expect(errors).toEqual([]);
});
