import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";

interface MeshWitness {
    position: { x: number; y: number; z: number };
    rotation: { y: number; w: number };
    scale: { x: number; y: number; z: number };
    material: number;
}

interface SpawnWitness {
    id: number;
    kind: "chaser" | "spinner" | "ranger";
    x: number;
    z: number;
    startTime: number;
    endTime: number;
    activateBeat: number;
    progress: number;
    body?: MeshWitness;
    beams: MeshWitness[];
    accents: MeshWitness[];
}

interface Snapshot {
    phase: string;
    generation: number;
    position: number;
    bodyCount: number;
    entityCount: number;
    combat: { enemies: number; health: number; kills: number };
    player: { position: { x: number; z: number } };
    playerStats: { metrics: { hits: number } };
    enemies: { id: number; health: number; maxHealth: number; body?: MeshWitness }[];
    enemyHealthbars: number;
    pendingSpawns: SpawnWitness[];
    spawnPresentationCount: number;
    visuals: { motionAllowed: boolean };
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
}

async function practice(page: Page) {
    // A one-second beat provides enough room to inspect the real animation
    // without seeking the transport or mutating simulation state.
    await page.locator("#bs-dojo-bpm").fill("60");
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.mouse.move(1150, 90);
}

async function arrival(page: Page, progress: number) {
    await page.waitForFunction(progress => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        const spawn = s.pendingSpawns[0];
        return spawn && spawn.progress >= progress && spawn.progress < progress + 0.15 && spawn.body;
    }, progress, { polling: "raf", timeout: 12_000 });
    return snapshot(page);
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function aimAwayFrom(page: Page, spawn: SpawnWitness) {
    const point = await page.evaluate(spawn => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const player = api.snapshot().player.position;
        const projected = api.project([player.x * 2 - spawn.x, 0.55, player.z * 2 - spawn.z]);
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return projected ? { x: bounds.left + projected[0], y: bounds.top + projected[1] } : null;
    }, spawn);
    expect(point).not.toBeNull();
    await page.mouse.move(point!.x, point!.y);
}

function onlyTelegraph(state: Snapshot, initial: Snapshot) {
    expect(state.combat.enemies).toBe(0);
    expect(state.enemies).toEqual([]);
    expect(state.enemyHealthbars).toBe(0);
    expect(state.bodyCount).toBe(initial.bodyCount);
    expect(state.playerStats.metrics.hits).toBe(0);
    expect(state.combat.kills).toBe(0);
    expect(state.combat.health).toBe(initial.combat.health);
    expect(state.pendingSpawns).toHaveLength(1);
    expect(state.spawnPresentationCount).toBe(1);
}

test.setTimeout(60_000);

test("enemies beam in for one authored beat, freeze on pause, and only then acquire combat bodies", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const initial = await snapshot(page);
    await practice(page);
    const early = await arrival(page, 0.14);
    const first = early.pendingSpawns[0]!;
    onlyTelegraph(early, initial);
    expect(first.startTime).toBe(0);
    expect(first.endTime).toBe(1);
    expect(first.activateBeat).toBe(1);
    expect(first.progress).toBeCloseTo((early.position - first.startTime) / (first.endTime - first.startTime), 5);
    expect(first.body!.scale.x).toBeGreaterThan(0);
    expect(first.beams.some(beam => beam.scale.x > 0 && beam.scale.y > 0)).toBe(true);
    await aimAwayFrom(page, first);

    const middle = await arrival(page, 0.35);
    const grown = middle.pendingSpawns[0]!;
    onlyTelegraph(middle, initial);
    expect(grown.id).toBe(first.id);
    expect(grown.body!.scale.x).toBeGreaterThan(first.body!.scale.x);
    expect(grown.body!.position.y).toBeLessThan(first.body!.position.y);
    expect(grown.body!.rotation).not.toEqual(first.body!.rotation);
    expect(grown.body!.position.x).toBe(first.body!.position.x);
    expect(grown.body!.position.z).toBe(first.body!.position.z);

    // Capture the unobscured beam before opening the pause cover.
    const screenshotPath = "output/playwright/enemy-arrival.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("enemy-beam-arrival", { path: screenshotPath, contentType: "image/png" });
    await pause(page);
    const held = await snapshot(page);
    onlyTelegraph(held, initial);
    expect(held.position).toBeLessThan(first.endTime);
    await page.waitForTimeout(300);
    const later = await snapshot(page);
    expect(later.position).toBe(held.position);
    expect(later.pendingSpawns).toEqual(held.pendingSpawns);
    expect(later.bodyCount).toBe(held.bodyCount);
    expect(later.combat).toEqual(held.combat);

    await page.getByRole("button", { name: "Resume session" }).click();
    await page.waitForFunction(id => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.enemies.some(enemy => enemy.id === id && enemy.body)
            && s.enemyHealthbars === 1 && s.spawnPresentationCount === 0;
    }, first.id, { polling: "raf", timeout: 5_000 });
    const active = await snapshot(page);
    expect(active.position).toBeGreaterThanOrEqual(first.endTime);
    expect(active.position).toBeLessThan(first.endTime + 0.15);
    expect(active.pendingSpawns).toEqual([]);
    expect(active.combat.enemies).toBe(1);
    expect(active.bodyCount).toBe(initial.bodyCount + 1);
    expect(active.enemies[0]!.health).toBe(active.enemies[0]!.maxHealth);
    expect(active.enemies[0]!.body!.scale.x).toBeGreaterThan(grown.body!.scale.x);

    await page.keyboard.press("KeyR");
    await chooseStartingUpgrade(page);
    await expect.poll(async () => (await snapshot(page)).generation).toBe(initial.generation + 2);
    await arrival(page, 0.2);
    await pause(page);
    await page.getByRole("button", { name: "Restart session" }).click();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(initial.generation + 3);
    await expect.poll(async () => (await snapshot(page)).spawnPresentationCount).toBe(0);
    const reset = await snapshot(page);
    expect(reset.position).toBeLessThan(0);
    expect(reset.pendingSpawns).toEqual([]);
    expect(reset.spawnPresentationCount).toBe(0);
    expect(reset.enemies).toEqual([]);
    expect(reset.enemyHealthbars).toBe(0);
    expect(reset.bodyCount).toBe(initial.bodyCount);
    expect(reset.entityCount).toBe(initial.entityCount);

    await arrival(page, 0.2);
    await pause(page);
    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).spawnPresentationCount).toBe(0);
    const cleared = await snapshot(page);
    expect(cleared.pendingSpawns).toEqual([]);
    expect(cleared.spawnPresentationCount).toBe(0);
    expect(cleared.bodyCount).toBe(initial.bodyCount);
    expect(cleared.entityCount).toBe(initial.entityCount);
    expect(errors).toEqual([]);
});

for (const mode of ["Off", "reduced motion"] as const) {
    test(`${mode} keeps a stationary arrival indicator without activating the enemy early`, async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: mode === "reduced motion" ? "reduce" : "no-preference" });
        await boot(page);
        if (mode === "Off") {
            await page.getByRole("button", { name: "Open settings" }).click();
            await page.getByRole("combobox", { name: "Visual effects", exact: true }).selectOption("off");
            await page.getByRole("button", { name: "Close settings", exact: true }).click();
        }
        const initial = await snapshot(page);
        await practice(page);
        const early = await arrival(page, 0.15);
        const first = early.pendingSpawns[0]!;
        onlyTelegraph(early, initial);
        expect(early.visuals.motionAllowed).toBe(false);
        await aimAwayFrom(page, first);
        const middle = await arrival(page, 0.55);
        const shown = middle.pendingSpawns[0]!;
        onlyTelegraph(middle, initial);
        expect(shown.progress).toBeGreaterThan(first.progress);
        expect(shown.body!.position).toEqual(first.body!.position);
        expect(shown.body!.rotation).toEqual(first.body!.rotation);
        expect([...shown.beams, ...shown.accents]
            .some(mesh => mesh.scale.x > 0 && mesh.scale.y > 0 && mesh.scale.z > 0)).toBe(true);
        const screenshotPath = `output/playwright/enemy-arrival-${mode === "Off" ? "off" : "reduced"}.png`;
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`enemy-arrival-${mode}`, { path: screenshotPath, contentType: "image/png" });
        await page.waitForFunction(id => {
            const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
            return s.enemies.some(enemy => enemy.id === id) && s.spawnPresentationCount === 0;
        }, first.id, { polling: "raf", timeout: 5_000 });
        const active = await snapshot(page);
        expect(active.position).toBeGreaterThanOrEqual(first.endTime);
        expect(active.pendingSpawns).toEqual([]);
        expect(active.bodyCount).toBe(initial.bodyCount + 1);
    });
}
