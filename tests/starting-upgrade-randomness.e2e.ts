import { expect, test, type Page } from "./fixtures";
import { chooseStartingUpgrade } from "./starting-upgrade";

test.use({ upgradeSeeds: [2026, 42, 99] });
test.setTimeout(45_000);

type Snapshot = {
    phase: string; position: number; generation: number;
    upgrade: { choices: { id: string }[]; pending: number; ranks: Record<string, number> };
};
type InspectedWindow = Window & { __beatshooter: { snapshot(): Snapshot } };
const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());
const cards = (page: Page) => page.locator(".bs-start-upgrade .bs-upgrade-card").evaluateAll(elements =>
    elements.map(element => (element as HTMLElement).dataset.upgradeId));

test("each menu start and restart takes fresh upgrade entropy while waiting and pause keep the offer stable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="starting"]')).toBeVisible();
    const first = await cards(page);
    expect(first).toEqual(["crit-chance", "pickup-radius", "dash-distance"]);
    const held = await snapshot(page);
    await page.waitForTimeout(250);
    expect(await cards(page)).toEqual(first);
    expect((await snapshot(page)).upgrade).toEqual(held.upgrade);
    expect((await snapshot(page)).position).toBe(held.position);

    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="starting"]')).toBeVisible();
    const second = await cards(page);
    expect(second).toEqual(["pickup-radius", "crit-chance", "health"]);
    expect(new Set(second)).not.toEqual(new Set(first));
    await chooseStartingUpgrade(page);
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const paused = await snapshot(page);
    await page.waitForTimeout(250);
    expect((await snapshot(page)).upgrade).toEqual(paused.upgrade);
    expect((await snapshot(page)).position).toBe(paused.position);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    expect((await snapshot(page)).upgrade).toEqual(paused.upgrade);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="starting"]')).toBeVisible();
    const third = await cards(page);
    expect(third).toEqual(["regeneration", "damage", "bounce"]);
    expect(new Set(third)).not.toEqual(new Set(second));
    const restarted = await snapshot(page);
    expect(restarted.generation).toBeGreaterThan(paused.generation);
    expect(restarted.upgrade.pending).toBe(1);
    expect(Object.values(restarted.upgrade.ranks).every(rank => rank === 0)).toBe(true);
    await page.waitForTimeout(250);
    expect(await cards(page)).toEqual(third);
    expect((await snapshot(page)).upgrade).toEqual(restarted.upgrade);
    expect(errors).toEqual([]);
});
