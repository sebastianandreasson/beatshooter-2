import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "./fixtures";

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
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
}

async function downbeat(page: Page, after: number) {
    await page.waitForFunction(after => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.position > after && s.dash.state === "ready" && s.position % 2 < 0.055;
    }, after, { polling: "raf", timeout: 10_000 });
}

async function beatAt(page: Page, time: number) {
    await page.waitForFunction(time => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.position >= time && s.position < time + .055;
    }, time, { polling: "raf", timeout: 5000 });
}

test.setTimeout(60_000);

test("Space accepts a non-first beat, rejects offbeat and repeated presses, and resets each bar", async ({ page }) => {
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
        return position > 0.72 && position < 0.8;
    }, undefined, { polling: "raf" });
    await page.keyboard.down("Space");
    await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().position > 2.2);
    expect((await snapshot(page)).dash.accepted).toBe(0);
    await page.keyboard.up("Space");
    await beatAt(page, 2.5);
    await expect(page.locator(".bs-beat-dots i").nth(1)).toHaveClass(/bs-dash-ready/);
    const before = await snapshot(page);
    await page.keyboard.down("KeyD");
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    const accepted = await snapshot(page);
    expect(accepted.dash.accepted).toBe(1);
    expect(accepted.dash.lastUsedBeat).toBe(5);
    expect(accepted.dash.active?.direction).toEqual({ x: 1, z: 0 });
    await expect.poll(async () => (await snapshot(page)).player.position.x).toBeGreaterThan(before.player.position.x + 2.5);
    await page.keyboard.up("KeyD");
    await page.waitForTimeout(250);
    const after = await snapshot(page);
    expect(after.dash.active).toBeUndefined();
    expect(after.dash.accepted).toBe(1);
    expect(Math.hypot(after.player.velocity.x, after.player.velocity.z)).toBeLessThan(8.01);
    expect(after.player.bodyY).toBeCloseTo(0.55, 4);
    await beatAt(page, 3.5);
    await page.keyboard.press("Space");
    expect((await snapshot(page)).dash.accepted).toBe(1);
    await expect(page.locator(".bs-dash-status")).toContainText("Used · next bar");
    await downbeat(page, 3.6);
    await page.keyboard.press("Space");
    expect((await snapshot(page)).dash.accepted).toBe(2);
    expect((await snapshot(page)).dash.lastUsedBeat).toBe(8);
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
    await chooseStartingUpgrade(page);
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.generation + 1);
    const reset = await snapshot(page);
    expect(reset.position).toBeLessThan(0);
    expect(reset.dash.accepted).toBe(0);
    expect(reset.dash.active).toBeUndefined();
    expect(reset.player.position.x).toBeCloseTo(0, 4);
    expect(reset.player.position.z).toBeCloseTo(0, 4);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 1024, height: 600 }]) {
    test(`health and bottom controls remain readable and clear of the beat indicator at ${viewport.width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await practice(page);
        await page.waitForFunction(() => (window as unknown as InspectedWindow).__beatshooter.snapshot().position > 0.1);
        const panel = page.locator(".bs-hud-bottom .bs-hud-beat");
        await expect(panel).toBeVisible();
        await expect(page.locator(".bs-hud-top .bs-hud-beat")).toHaveCount(0);
        const box = (await panel.boundingBox())!;
        const progress = (await page.locator(".bs-run-progress").boundingBox())!;
        expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(box.y).toBeGreaterThan(viewport.height / 2);
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

        const layout = await page.evaluate(() => {
            const rect = (element: Element) => {
                const box = element.getBoundingClientRect();
                return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
            };
            return {
                top: [".bs-vitals", ".bs-hud-score", ".bs-hud-top .bs-icon-button", ".bs-experience"]
                    .map(selector => ({ selector, ...rect(document.querySelector(selector)!) })),
                hints: rect(document.querySelector(".bs-hud-hint")!),
                controls: [...document.querySelectorAll(".bs-hud-hint > *")]
                    .filter(element => element.getBoundingClientRect().width > 0)
                    .map(element => ({ text: element.textContent, ...rect(element) })),
            };
        });
        const overlaps = (a: typeof layout.hints, b: typeof layout.hints) =>
            a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
        for (const item of [...layout.top, layout.hints, ...layout.controls]) {
            expect(item.x).toBeGreaterThanOrEqual(0);
            expect(item.right).toBeLessThanOrEqual(viewport.width);
            expect(item.y).toBeGreaterThanOrEqual(0);
            expect(item.bottom).toBeLessThanOrEqual(viewport.height);
        }
        for (let i = 0; i < layout.top.length; i++) {
            for (let j = i + 1; j < layout.top.length; j++) {
                expect(overlaps(layout.top[i]!, layout.top[j]!),
                    `${layout.top[i]!.selector} overlaps ${layout.top[j]!.selector}`).toBe(false);
            }
        }
        expect(progress.y + progress.height).toBeLessThanOrEqual(layout.hints.y);
        for (let i = 0; i < layout.controls.length; i++) {
            for (let j = i + 1; j < layout.controls.length; j++) {
                expect(overlaps(layout.controls[i]!, layout.controls[j]!),
                    `${layout.controls[i]!.text} overlaps ${layout.controls[j]!.text}`).toBe(false);
            }
        }
        const path = `output/playwright/dash-hud-${viewport.width}.png`;
        await page.screenshot({ path });
        await testInfo.attach(`hud-${viewport.width}`, { path, contentType: "image/png" });
    });
}
