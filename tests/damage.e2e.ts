import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "./fixtures";

type Point = { x: number; z: number };
interface Enemy extends Point {
    id: number;
    kind: "chaser" | "spinner" | "ranger";
    health: number;
    maxHealth: number;
    body?: { position: Point & { y: number } };
}
interface Snapshot {
    phase: string;
    generation: number;
    position: number;
    player: { position: Point };
    combat: { health: number; kills: number };
    enemies: Enemy[];
    enemyHealthbars: number;
    playerStats: {
        base: { damageMin: number; damageMax: number };
        effective: { damageMin: number; damageMax: number; criticalMultiplier: number };
        metrics: {
            shotsFired: number;
            hits: number;
            criticalHits: number;
            totalDamageDealt: number;
            lastHitDamage: number;
        };
    };
    visuals: { motionAllowed: boolean; frame: { position: number; beatCoordinate: number } };
    chart: { bpm: number };
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

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function observe(page: Page, targetId?: number) {
    return page.evaluate(targetId => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const state = api.snapshot(), player = state.player.position;
        const target = state.enemies.find(enemy => enemy.id === targetId)
            ?? [...state.enemies].sort((a, b) =>
                Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z),
            )[0];
        const point = target && api.project([target.x, 0.55, target.z]);
        const canvas = document.querySelector("canvas")!.getBoundingClientRect();
        const bars = [...document.querySelectorAll<HTMLElement>(".enemy-healthbar")].map(element => {
            const enemyId = Number(element.dataset.enemyId);
            const enemy = state.enemies.find(enemy => enemy.id === enemyId);
            const body = enemy?.body?.position;
            const projected = body && api.project([body.x, body.y, body.z]);
            const rect = element.getBoundingClientRect();
            const fill = element.querySelector<HTMLElement>(".enemy-healthbar-fill")!;
            return {
                enemyId,
                health: Number(element.dataset.health),
                maxHealth: Number(element.dataset.maxHealth),
                fill: new DOMMatrixReadOnly(getComputedStyle(fill).transform).a,
                style: element.getAttribute("style"),
                fillStyle: fill.getAttribute("style"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                bodyScreen: projected ? { x: projected[0] + canvas.left, y: projected[1] + canvas.top } : null,
            };
        });
        const numbers = [...document.querySelectorAll<HTMLElement>(".damage-number")].map(element => ({
            eventId: Number(element.dataset.eventId),
            targetId: element.dataset.targetId === undefined ? undefined : Number(element.dataset.targetId),
            kind: element.dataset.kind,
            amount: Number(element.dataset.amount),
            critical: element.dataset.critical === "true",
            birth: Number(element.dataset.birth),
            progress: Number(element.dataset.progress),
            rise: Number(element.dataset.rise),
            scale: Number(element.dataset.scale),
            text: element.textContent ?? "",
            style: element.getAttribute("style"),
        }));
        return {
            state, bars, numbers,
            pointer: point ? { x: point[0] + canvas.left, y: point[1] + canvas.top } : null,
        };
    }, targetId);
}

type Observation = Awaited<ReturnType<typeof observe>>;

async function aimUntil(page: Page, predicate: (observed: Observation) => boolean, targetId?: number) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const observed = await observe(page, targetId);
        expect(observed.state.phase).toBe("playing");
        if (predicate(observed)) return observed;
        if (observed.pointer) await page.mouse.move(observed.pointer.x, observed.pointer.y);
        await page.waitForTimeout(35);
    }
    throw new Error("Ordinary aim did not produce the expected damage feedback within 15 seconds.");
}

function nonfatalHit(observed: Observation) {
    return observed.numbers.find(number => number.kind === "hit"
        && observed.state.enemies.some(enemy => enemy.id === number.targetId && enemy.health < enemy.maxHealth));
}

function assertDamage(observed: Observation) {
    const metrics = observed.state.playerStats.metrics;
    expect(metrics.shotsFired).toBeGreaterThanOrEqual(metrics.hits);
    expect(metrics.hits).toBeGreaterThan(0);
    expect(metrics.criticalHits).toBeLessThanOrEqual(metrics.hits);
    // A run has no regeneration or non-player enemy damage: count health
    // actually removed, including the final partial hit, rather than overkill.
    expect(metrics.totalDamageDealt).toBe(observed.state.combat.kills * 24
        + observed.state.enemies.reduce((total, enemy) => total + enemy.maxHealth - enemy.health, 0));
    for (const number of observed.numbers.filter(number => number.kind === "hit" || number.kind === "kill")) {
        const multiplier = number.critical ? observed.state.playerStats.effective.criticalMultiplier : 1;
        expect(number.amount).toBeGreaterThanOrEqual(Math.round(13 * multiplier));
        expect(number.amount).toBeLessThanOrEqual(Math.round(17 * multiplier));
        expect([13, 14, 15, 16, 17].map(value => Math.round(value * multiplier))).toContain(number.amount);
        expect(Number(number.text.replace("✦", "").trim())).toBe(number.amount);
        expect(number.text).not.toContain("+100");
    }
}

test.setTimeout(60_000);

test("enemy health bars, beat-timed hit and kill numbers, and player damage statistics follow real combat and retry", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.mouse.move(1150, 90);
    // Let each enemy archetype spawn naturally while shots point away.
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return ["chaser", "spinner", "ranger"].every(kind => state.enemies.some(enemy => enemy.kind === kind))
            && document.querySelectorAll(".enemy-healthbar").length === state.enemies.length;
    }, undefined, { polling: "raf", timeout: 10_000 });
    const full = await observe(page);
    expect(full.state.playerStats.base).toMatchObject({ damageMin: 13, damageMax: 17 });
    expect(full.state.playerStats.effective).toEqual({ ...full.state.playerStats.base, pickupRadiusMultiplier: 1.25 });
    expect(full.state.enemyHealthbars).toBe(full.state.enemies.length);
    for (const enemy of full.state.enemies) {
        const bar = full.bars.find(bar => bar.enemyId === enemy.id)!;
        expect(bar).toBeDefined();
        expect(bar.health).toBe(enemy.health);
        expect(bar.maxHealth).toBe(enemy.maxHealth);
        expect(bar.fill).toBeCloseTo(enemy.health / enemy.maxHealth, 5);
        expect(bar.rect.width).toBeGreaterThan(20);
        expect(bar.rect.width).toBeLessThan(50);
        expect(bar.bodyScreen).not.toBeNull();
        expect(Math.abs(bar.rect.x + bar.rect.width / 2 - bar.bodyScreen!.x)).toBeLessThan(6);
        expect(bar.rect.y + bar.rect.height).toBeLessThan(bar.bodyScreen!.y - 5);
    }

    const damaged = await aimUntil(page, observed => Boolean(nonfatalHit(observed)));
    const hit = nonfatalHit(damaged)!;
    const beatDuration = 60 / damaged.state.chart.bpm;
    const hitAccent = Math.ceil(hit.birth / beatDuration - 1e-9);
    if (damaged.state.visuals.frame.beatCoordinate < hitAccent) {
        // Essential feedback appears at impact, but its animation waits for
        // the shared musical accent instead of starting an independent timer.
        expect(hit.progress).toBe(0);
        expect(hit.rise).toBe(0);
        expect(hit.scale).toBe(0.55);
    }
    const enemy = damaged.state.enemies.find(enemy => enemy.id === hit.targetId)!;
    const bar = damaged.bars.find(bar => bar.enemyId === enemy.id)!;
    expect(enemy.health).toBe(enemy.maxHealth - hit.amount);
    expect(bar.health).toBe(enemy.health);
    expect(bar.fill).toBeCloseTo(enemy.health / enemy.maxHealth, 5);
    assertDamage(damaged);
    await pause(page);
    const held = await observe(page);
    expect(held.numbers.some(number => number.eventId === hit.eventId)).toBe(true);
    await page.waitForTimeout(300);
    const still = await observe(page);
    expect(still.state.position).toBe(held.state.position);
    expect(still.state.playerStats).toEqual(held.state.playerStats);
    expect(still.state.enemies).toEqual(held.state.enemies);
    expect(still.bars).toEqual(held.bars);
    expect(still.numbers).toEqual(held.numbers);

    await page.getByRole("button", { name: "Resume session" }).click();
    const killed = await aimUntil(page, observed =>
        observed.numbers.some(number => number.kind === "kill" && number.targetId === enemy.id), enemy.id);
    const killingNumber = killed.numbers.find(number => number.kind === "kill" && number.targetId === enemy.id)!;
    expect(killed.state.enemies.some(alive => alive.id === enemy.id)).toBe(false);
    expect(killed.bars.some(alive => alive.enemyId === enemy.id)).toBe(false);
    assertDamage(killed);
    expect(killed.state.playerStats.metrics.lastHitDamage).toBe(enemy.health);
    const exitBeat = Math.ceil(killingNumber.birth / beatDuration - 1e-9);
    const animateAt = Math.max(exitBeat + 0.3, killed.state.visuals.frame.beatCoordinate + 0.15);
    await page.waitForFunction(coordinate =>
        (window as unknown as InspectedWindow).__beatshooter.snapshot().visuals.frame.beatCoordinate > coordinate,
    animateAt, { polling: "raf" });
    const advanced = await observe(page);
    const animated = advanced.numbers.find(number => number.eventId === killingNumber.eventId)!;
    expect(animated).toBeDefined();
    expect(animated.progress).toBeGreaterThan(killingNumber.progress);
    expect(animated.rise).toBeGreaterThan(killingNumber.rise);
    expect(animated.progress).toBeCloseTo(advanced.state.visuals.frame.beatCoordinate - exitBeat, 1);
    expect(advanced.state.visuals.frame.beatCoordinate).toBeLessThan(exitBeat + 1);
    const screenshot = "output/playwright/damage-healthbars-and-numbers.png";
    await page.screenshot({ path: screenshot });
    await testInfo.attach("damage-healthbars-and-numbers", { path: screenshot, contentType: "image/png" });

    await page.keyboard.press("KeyR");
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.state.generation + 1);
    await expect(page.locator(".enemy-healthbar")).toHaveCount(0);
    await expect(page.locator(".damage-number")).toHaveCount(0);
    const fresh = await snapshot(page);
    expect(fresh.position).toBeLessThan(0);
    expect(fresh.enemyHealthbars).toBe(0);
    expect(fresh.playerStats.base).toEqual(full.state.playerStats.base);
    expect(fresh.playerStats.effective).toEqual(full.state.playerStats.effective);
    expect(fresh.playerStats.metrics).toEqual({
        shotsFired: 0, hits: 0, criticalHits: 0, totalDamageDealt: 0, lastHitDamage: 0,
    });
    expect(errors).toEqual([]);
});

test("damage and health stay readable with effects Off and with reduced motion", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("combobox", { name: "Visual effects", exact: true }).selectOption("off");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    const off = await aimUntil(page, observed => Boolean(nonfatalHit(observed)));
    const offHit = nonfatalHit(off)!;
    expect(off.state.visuals.motionAllowed).toBe(false);
    expect(offHit.rise).toBe(0);
    expect(offHit.scale).toBe(1);
    await expect(page.locator(`.damage-number[data-event-id="${offHit.eventId}"]`)).toBeVisible();
    await expect(page.locator(`.enemy-healthbar[data-enemy-id="${offHit.targetId}"]`)).toBeVisible();
    assertDamage(off);

    await pause(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Visual effects", exact: true }).selectOption("standard");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Restart session" }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(off.state.generation + 1);
    const reduced = await aimUntil(page, observed => Boolean(nonfatalHit(observed)));
    const reducedHit = nonfatalHit(reduced)!;
    expect(reduced.state.visuals.motionAllowed).toBe(false);
    expect(reducedHit.rise).toBe(0);
    expect(reducedHit.scale).toBe(1);
    await expect(page.locator(`.damage-number[data-event-id="${reducedHit.eventId}"]`)).toBeVisible();
    await expect(page.locator(`.enemy-healthbar[data-enemy-id="${reducedHit.targetId}"]`)).toBeVisible();
    assertDamage(reduced);
    const screenshot = "output/playwright/damage-reduced-motion.png";
    await page.screenshot({ path: screenshot });
    await testInfo.attach("damage-reduced-motion", { path: screenshot, contentType: "image/png" });
});
