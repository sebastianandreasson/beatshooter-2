import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";
import { DEFAULT_EXPERIENCE_TUNING } from "../src/experience/state";

const firstRequirement = DEFAULT_EXPERIENCE_TUNING.initialRequirement;
const secondRequirement = firstRequirement + DEFAULT_EXPERIENCE_TUNING.requirementGrowth;

type Point = { x: number; z: number };
interface Drop extends Point {
    id: number;
    value: number;
    attracted: boolean;
    speed: number;
    mesh?: {
        position: { x: number; y: number; z: number };
        rotation: { y: number; w: number };
        scale: { x: number; y: number; z: number };
        material: number;
    };
}
interface Snapshot {
    phase: string;
    generation: number;
    position: number;
    entityCount: number;
    bodyCount: number;
    player: { position: Point };
    combat: { health: number; kills: number };
    enemies: (Point & { id: number })[];
    experience: {
        level: number;
        xp: number;
        requiredXp: number;
        totalXp: number;
        renderedDrops: number;
        drops: Drop[];
    };
    visuals: {
        motionAllowed: boolean;
        activeShards: number;
        particlePoses: { x: number; y: number; z: number }[];
        levelUpBursts: {
            id: number; birth: number; songTime: number; visualTime: number;
            amount: number; quiet: boolean;
        }[];
    };
}
type InspectedWindow = Window & {
    __beatshooter: {
        snapshot(): Snapshot;
        project(point: [number, number, number]): [number, number] | null;
    };
};

const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

async function boot(page: Page) {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function observe(page: Page) {
    return page.evaluate(() => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const state = api.snapshot(), player = state.player.position;
        const enemy = [...state.enemies].sort((a, b) =>
            Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z),
        )[0];
        const point = enemy && api.project([enemy.x, 0.55, enemy.z]);
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return {
            state,
            pointer: point ? { x: point[0] + bounds.left, y: point[1] + bounds.top } : null,
        };
    });
}

async function moveToward(page: Page, held: Set<string>, player: Point, target?: Point) {
    const desired = new Set<string>();
    if (target) {
        if (target.x - player.x > 0.25) desired.add("KeyD");
        if (target.x - player.x < -0.25) desired.add("KeyA");
        if (target.z - player.z > 0.25) desired.add("KeyS");
        if (target.z - player.z < -0.25) desired.add("KeyW");
    }
    for (const key of held) {
        if (!desired.has(key)) { await page.keyboard.up(key); held.delete(key); }
    }
    for (const key of desired) {
        if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
    }
}

async function assertClearLayout(page: Page) {
    const experience = await page.locator(".bs-experience").boundingBox();
    expect(experience).not.toBeNull();
    expect(experience!.x).toBeGreaterThanOrEqual(0);
    expect(experience!.x + experience!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    for (const selector of [".bs-vitals", ".bs-hud-score", ".bs-hud-beat"]) {
        const other = await page.locator(selector).boundingBox();
        expect(other, selector).not.toBeNull();
        const overlaps = experience!.x < other!.x + other!.width
            && experience!.x + experience!.width > other!.x
            && experience!.y < other!.y + other!.height
            && experience!.y + experience!.height > other!.y;
        expect(overlaps, `XP HUD should not overlap ${selector}`).toBe(false);
    }
}

test.setTimeout(65_000);

test("enemy gems wait on the floor, attract nearby, level the player, and reset with the run", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const initial = await snapshot(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await assertClearLayout(page);
    // The HUD remains available while the live upgrade panel is open.
    const bar = page.getByRole("progressbar", { name: "Experience to next level", exact: true, includeHidden: true });
    await expect(bar).toHaveAttribute("max", String(firstRequirement));
    await expect(bar).toHaveAttribute("value", "0");
    await expect(page.locator('[data-value="level"]')).toHaveText("1");

    // Stay in the center and aim using only real pointer input. The first
    // elimination must leave its XP at the enemy, rather than award it remotely.
    let firstDrop: Drop | undefined;
    const firstDeadline = Date.now() + 12_000;
    while (Date.now() < firstDeadline && !firstDrop) {
        const observed = await observe(page);
        expect(observed.state.phase).toBe("playing");
        firstDrop = observed.state.experience.drops[0];
        if (observed.pointer) await page.mouse.move(observed.pointer.x, observed.pointer.y);
        if (!firstDrop) await page.waitForTimeout(50);
    }
    expect(firstDrop).toBeDefined();
    const dropped = await snapshot(page);
    expect(dropped.combat.kills).toBeGreaterThan(0);
    expect(dropped.experience.totalXp).toBe(0);
    expect(firstDrop!.value).toBe(10);
    expect(firstDrop!.attracted).toBe(false);
    expect(Math.hypot(firstDrop!.x - dropped.player.position.x,
        firstDrop!.z - dropped.player.position.z)).toBeGreaterThan(5);
    await expect.poll(async () => (await snapshot(page)).experience.renderedDrops).toBeGreaterThan(0);
    const dropScreenshot = "output/playwright/experience-first-drop.png";
    await page.screenshot({ path: dropScreenshot });
    await testInfo.attach("experience-first-drop", { path: dropScreenshot, contentType: "image/png" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await snapshot(page)).visuals.motionAllowed).toBe(false);
    await pause(page);
    const heldDrop = await snapshot(page);
    const heldGem = heldDrop.experience.drops.find(drop => drop.id === firstDrop!.id)?.mesh;
    expect(heldGem).toBeDefined();
    expect(heldGem!.scale.x).toBeGreaterThan(0);
    expect(heldGem!.scale.y).toBeGreaterThan(0);
    expect(heldGem!.scale.z).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const stillDrop = await snapshot(page);
    expect(stillDrop.position).toBe(heldDrop.position);
    expect(stillDrop.experience).toEqual(heldDrop.experience);
    await page.getByRole("button", { name: "Resume session" }).click();

    // Chase the nearest loose gem while continuing to aim at enemies. These
    // keyboard events exercise ordinary movement, magnet pickup and auto-fire;
    // no fixture grants XP, teleports the player or forces a level-up.
    const heldKeys = new Set<string>();
    let sawAttraction = false;
    let sawFirstAward = false;
    let levelled: Snapshot | undefined;
    const collectDeadline = Date.now() + 30_000;
    try {
        while (Date.now() < collectDeadline) {
            const observed = await observe(page), state = observed.state;
            expect(state.phase).toBe("playing");
            sawAttraction ||= state.experience.drops.some(drop => drop.attracted && drop.speed > 0);
            if (state.experience.totalXp >= 10 && !sawFirstAward) {
                sawFirstAward = true;
                expect(state.experience.totalXp).toBe(10);
                expect(state.experience.level).toBe(1);
                expect(state.experience.xp).toBe(10);
                expect(state.experience.drops.some(drop => drop.id === firstDrop!.id)).toBe(false);
                expect(state.visuals.motionAllowed).toBe(false);
                await page.emulateMedia({ reducedMotion: "no-preference" });
            }
            if (state.experience.level >= 2) { levelled = state; break; }
            const player = state.player.position;
            const nearest = [...state.experience.drops].sort((a, b) =>
                Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z),
            )[0];
            await moveToward(page, heldKeys, player, nearest);
            if (observed.pointer) await page.mouse.move(observed.pointer.x, observed.pointer.y);
            await page.waitForTimeout(50);
        }
    } finally {
        for (const key of heldKeys) await page.keyboard.up(key);
    }
    expect(sawAttraction).toBe(true);
    expect(sawFirstAward).toBe(true);
    expect(levelled).toBeDefined();
    expect(levelled!.experience.level).toBe(2);
    expect(levelled!.experience.requiredXp).toBe(secondRequirement);
    expect(levelled!.experience.totalXp).toBeGreaterThanOrEqual(firstRequirement);
    expect(levelled!.experience.xp).toBe(levelled!.experience.totalXp - firstRequirement);
    await expect(page.locator('[data-value="level"]')).toHaveText("2");
    await expect(bar).toHaveAttribute("max", String(secondRequirement));
    await expect(bar).toHaveAttribute("value", String(levelled!.experience.xp));
    await page.waitForFunction(() => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.visuals.levelUpBursts.length > 0 && s.visuals.activeShards > 0;
    }, undefined, { polling: "raf", timeout: 1500 });
    const celebrating = await snapshot(page);
    const burst = celebrating.visuals.levelUpBursts.at(-1)!;
    expect(burst.birth).toBeGreaterThanOrEqual(burst.visualTime - 0.000001);
    expect(burst.birth - burst.visualTime).toBeLessThanOrEqual(0.100001);
    expect(burst.amount).toBe(2);
    const levelScreenshot = "output/playwright/experience-level-up.png";
    await page.screenshot({ path: levelScreenshot });
    await testInfo.attach("experience-level-up", { path: levelScreenshot, contentType: "image/png" });
    await expect(page.locator(".bs-upgrade-panel")).toBeVisible();
    await expect(page.locator(".bs-upgrade-card")).toHaveCount(3);
    await expect(page.locator(".bs-upgrade-card").first()).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const heldLevel = await snapshot(page);
    expect(heldLevel.visuals.activeShards).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const stillLevel = await snapshot(page);
    expect(stillLevel.position).toBe(heldLevel.position);
    expect(stillLevel.experience).toEqual(heldLevel.experience);
    expect(stillLevel.visuals.particlePoses).toEqual(heldLevel.visuals.particlePoses);
    expect(stillLevel.visuals.levelUpBursts).toEqual(heldLevel.visuals.levelUpBursts);
    await page.getByRole("button", { name: "Resume session" }).click();
    await page.locator(".bs-upgrade-card").first().click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await pause(page);
    await page.getByRole("button", { name: "Restart session" }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(heldLevel.generation + 1);
    await expect.poll(async () => (await snapshot(page)).experience.renderedDrops).toBe(0);
    const fresh = await snapshot(page);
    expect(fresh.position).toBeLessThanOrEqual(0);
    expect(fresh.experience).toEqual({
        level: 1, xp: 0, requiredXp: firstRequirement, totalXp: 0, renderedDrops: 0, drops: [],
    });
    expect(fresh.visuals.levelUpBursts).toEqual([]);
    expect(fresh.visuals.activeShards).toBe(0);
    expect(fresh.entityCount).toBe(initial.entityCount);
    expect(fresh.bodyCount).toBe(initial.bodyCount);
    await expect(page.locator('[data-value="level"]')).toHaveText("1");
    await expect(bar).toHaveAttribute("max", String(firstRequirement));
    await expect(bar).toHaveAttribute("value", "0");
    expect(errors).toEqual([]);
});

test("the XP strip remains readable without covering health or beat timing on a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await assertClearLayout(page);
    const bar = page.getByRole("progressbar", { name: "Experience to next level", exact: true });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("max", String(firstRequirement));
    await expect(bar).toHaveAttribute("value", "0");
    await expect(bar).toHaveAttribute("aria-valuetext", `Level 1, 0 of ${firstRequirement} experience to next level`);
    await expect(page.locator('[data-value="level"]')).toHaveText("1");
    const screenshot = "output/playwright/experience-mobile-hud.png";
    await page.screenshot({ path: screenshot });
    await testInfo.attach("experience-mobile-hud", { path: screenshot, contentType: "image/png" });
});
