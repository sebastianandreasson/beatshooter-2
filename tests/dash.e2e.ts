import { expect, test, type Page } from "playwright/test";

interface Snapshot {
    phase: string;
    generation: number;
    position: number;
    player: {
        position: { x: number; z: number };
        velocity: { x: number; z: number };
        bodyY: number;
    };
    dash: {
        state: string; accepted: number; lastUsedBeat: number;
        active?: { startedAt: number; endsAt: number; direction: { x: number; z: number }; speed: number };
    };
}
type InspectedWindow = Window & { __beatshooter: { snapshot(): Snapshot } };
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as InspectedWindow).__beatshooter.snapshot());

async function practice(page: Page) {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
}

async function downbeat(page: Page, after: number) {
    await page.waitForFunction(after => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.position > after && s.dash.state === "ready" && s.position % 2 < 0.055;
    }, after, { polling: "raf", timeout: 10_000 });
}

test.setTimeout(60_000);

test("Space requires a fresh on-downbeat press, moves in the held direction, and cannot repeat within a bar", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await practice(page);
    expect((await snapshot(page)).position).toBeLessThan(0);
    await page.keyboard.down("Space");
    await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().position > 0.25);
    expect((await snapshot(page)).dash.accepted).toBe(0);
    await page.keyboard.up("Space");
    await page.waitForFunction(() => {
        const position = (window as unknown as InspectedWindow).__beatshooter.snapshot().position;
        return position > 0.4 && position < 0.8;
    }, undefined, { polling: "raf" });
    await page.keyboard.down("Space");
    await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().position > 2.2);
    expect((await snapshot(page)).dash.accepted).toBe(0);
    await page.keyboard.up("Space");
    await downbeat(page, 3);
    const before = await snapshot(page);
    await page.keyboard.down("KeyD");
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    const accepted = await snapshot(page);
    expect(accepted.dash.accepted).toBe(1);
    expect(accepted.dash.lastUsedBeat).toBe(8);
    expect(accepted.dash.active?.direction).toEqual({ x: 1, z: 0 });
    await expect.poll(async () => (await snapshot(page)).player.position.x).toBeGreaterThan(before.player.position.x + 2.5);
    await page.keyboard.up("KeyD");
    await page.waitForTimeout(250);
    const after = await snapshot(page);
    expect(after.dash.active).toBeUndefined();
    expect(after.dash.accepted).toBe(1);
    expect(Math.hypot(after.player.velocity.x, after.player.velocity.z)).toBeLessThan(8.01);
    expect(after.player.bodyY).toBeCloseTo(0.55, 4);
    expect(errors).toEqual([]);
});

test("stationary dash follows aim, pauses with music, and retry clears it", async ({ page }) => {
    await practice(page);
    await page.mouse.move(1100, 500);
    await downbeat(page, 0.5);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().dash.accepted === 1);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const held = await snapshot(page);
    expect(held.dash.active?.direction.x).toBeGreaterThan(0.8);
    await page.waitForTimeout(250);
    const later = await snapshot(page);
    expect(later.position).toBe(held.position);
    expect(later.player.position).toEqual(held.player.position);
    expect(later.dash).toEqual(held.dash);
    await page.getByRole("button", { name: "Resume session" }).click();
    await expect.poll(async () => (await snapshot(page)).dash.active).toBeUndefined();
    expect((await snapshot(page)).dash.accepted).toBe(1);
    await page.keyboard.press("KeyR");
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.generation + 1);
    const reset = await snapshot(page);
    expect(reset.position).toBeLessThan(0);
    expect(reset.dash.accepted).toBe(0);
    expect(reset.dash.active).toBeUndefined();
    expect(reset.player.position.x).toBeCloseTo(0, 4);
    expect(reset.player.position.z).toBeCloseTo(0, 4);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`larger beat indicator is centered at the bottom without overlap at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await practice(page);
        await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().position > 0.1);
        const panel = page.locator(".bs-hud-bottom .bs-hud-beat");
        await expect(panel).toBeVisible();
        await expect(page.locator(".bs-hud-top .bs-hud-beat")).toHaveCount(0);
        const box = (await panel.boundingBox())!;
        const progress = (await page.locator(".bs-run-progress").boundingBox())!;
        expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(box.y).toBeGreaterThan(viewport.height * 0.65);
        expect(box.y + box.height).toBeLessThanOrEqual(progress.y);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        const markers = page.locator(".bs-beat-dots i");
        await expect(markers).toHaveCount(4);
        const sizes = await markers.evaluateAll(elements => elements.map(element => ({
            width: parseFloat(getComputedStyle(element).width), height: parseFloat(getComputedStyle(element).height),
        })));
        expect(sizes[0]!.width).toBeGreaterThanOrEqual(24);
        expect(sizes[1]!.width).toBeGreaterThanOrEqual(18);
        await expect(page.locator(".bs-dash-status")).toContainText("SPACE");
        await page.screenshot({ path: `output/playwright/dash-hud-${viewport.width}.png` });
    });
}
