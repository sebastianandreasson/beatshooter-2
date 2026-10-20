import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";
import type { UpgradeId } from "../src/upgrades";

type Point = { x: number; z: number };
interface Snapshot {
    phase: string;
    position: number;
    playbackRate: number;
    simulationScale: number;
    player: { position: Point };
    dash: { state: string; accepted: number };
    combat: { health: number; time: number; kills: number };
    enemies: (Point & { id: number })[];
    projectiles: (Point & {
        id: number; shooterId: number; waitingForBounce: boolean;
        bouncesRemaining: number; hitEnemyIds: number[]; lastBounceBeat: number;
        velocityX: number; velocityZ: number;
    })[];
    experience: { level: number; drops: Point[]; totalXp: number };
    playerStats: {
        effective: { barrageCount: number; bounces: number };
        metrics: { shotsFired: number };
    };
    upgrade: {
        choices: { id: UpgradeId }[]; ranks: Record<UpgradeId, number>; pending: number;
        offeredLevel: number;
    };
    visuals: { frame: { beatIndex: number; beatPhase: number } };
}
type InspectedWindow = Window & { __beatshooter: {
    snapshot(): Snapshot;
    project(point: [number, number, number]): [number, number] | null;
} };
const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`the full-screen starting upgrade explains live choices and waits for selection at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto("/?test=1");
        await page.getByRole("button", { name: "Enter the arena", exact: true }).click();
        const panel = page.getByRole("dialog", { name: "Start of run upgrade", exact: true });
        await expect(panel).toBeVisible();
        await expect(panel).toContainText("Later upgrades appear on the right");
        await expect(panel).toContainText("Extra upgrades queue");
        await expect(panel.locator(".bs-upgrade-card")).toHaveCount(3);
        const before = await snapshot(page);
        expect(before.phase).toBe("starting");
        expect(before.playbackRate).toBe(0);
        expect(before.experience.level).toBe(1);
        expect(before.upgrade.pending).toBe(1);
        await page.waitForTimeout(250);
        await page.keyboard.press("Escape");
        expect((await snapshot(page)).position).toBe(before.position);
        expect((await snapshot(page)).phase).toBe("starting");
        expect(await page.locator('[data-screen="hud"]').evaluate(el => (el as HTMLElement).inert)).toBe(true);
        await page.screenshot({ path: `output/playwright/starting-upgrade-${viewport.width}.png` });
        const chosen = before.upgrade.choices[2]!;
        await page.keyboard.press("3");
        await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
        const started = await snapshot(page);
        expect(started.position).toBeLessThan(0);
        expect(started.upgrade.ranks[chosen.id]).toBe(1);
        expect(started.upgrade.pending).toBe(0);
        expect(started.experience.totalXp).toBe(0);
        await expect(panel).toBeHidden();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Restart session", exact: true }).click();
        await expect(panel).toBeVisible();
        const fresh = await snapshot(page);
        expect(Object.values(fresh.upgrade.ranks).every(rank => rank === 0)).toBe(true);
        expect(fresh.upgrade.pending).toBe(1);
        await page.getByRole("button", { name: "Return to menu", exact: true }).click();
        await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    });
}

async function aim(page: Page) {
    const observed = await page.evaluate(() => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const state = api.snapshot(), player = state.player.position;
        const nearest = [...state.enemies].sort((a, b) =>
            Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))[0];
        const point = nearest && api.project([nearest.x, 0.55, nearest.z]);
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return { state, pointer: point ? { x: point[0] + bounds.left, y: point[1] + bounds.top } : null };
    });
    if (observed.pointer) await page.mouse.move(observed.pointer.x, observed.pointer.y);
    return observed.state;
}

/** Earn the upgrade with ordinary aim, movement and gem pickups. */
async function earnUpgrade(page: Page, demo = true) {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: demo ? "Enter the arena" : "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    return collectUntil(page, state => state.upgrade.pending > 0);
}

async function collectUntil(page: Page, ready: (state: Snapshot) => boolean) {
    const held = new Set<string>();
    const deadline = Date.now() + 35_000;
    try {
        while (Date.now() < deadline) {
            const state = await aim(page);
            if (ready(state)) return state;
            expect(state.phase).toBe("playing");
            const player = state.player.position;
            const drop = [...state.experience.drops].sort((a, b) =>
                Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))[0];
            const desired = new Set<string>();
            if (drop) {
                if (drop.x - player.x > 0.25) desired.add("KeyD");
                if (drop.x - player.x < -0.25) desired.add("KeyA");
                if (drop.z - player.z > 0.25) desired.add("KeyS");
                if (drop.z - player.z < -0.25) desired.add("KeyW");
            }
            for (const key of held) if (!desired.has(key)) {
                await page.keyboard.up(key); held.delete(key);
            }
            for (const key of desired) if (!held.has(key)) {
                await page.keyboard.down(key); held.add(key);
            }
            await page.waitForTimeout(25);
        }
        throw new Error("Ordinary play did not earn an upgrade within 35 seconds.");
    } finally {
        for (const key of held) await page.keyboard.up(key);
    }
}

test.setTimeout(65_000);

test("upgrade choices leave music and movement running, apply immediately, and retain normal pause", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    const first = await earnUpgrade(page);
    await expect(page.locator(".bs-upgrade-card")).toHaveCount(3);
    await expect(page.locator(".bs-upgrade-card").first()).toBeEnabled();
    expect(first.phase).toBe("playing");
    expect(first.playbackRate).toBe(1);
    expect(first.simulationScale).toBe(1);
    expect(await page.locator('[data-screen="hud"]').evaluate(el => (el as HTMLElement).inert)).toBe(false);
    expect(await page.evaluate(() => !!document.activeElement?.closest(".bs-upgrade-panel"))).toBe(false);
    const heldOffer = first.upgrade.choices;
    const direction = first.player.position.x > 0 ? "KeyA" : "KeyD";
    await page.keyboard.down(direction);
    await page.waitForTimeout(350);
    await page.keyboard.up(direction);
    const moving = await snapshot(page);
    expect(moving.position - first.position).toBeGreaterThan(.25);
    expect(moving.combat.time - first.combat.time).toBeGreaterThan(.25);
    expect(Math.abs(moving.player.position.x - first.player.position.x)).toBeGreaterThan(.5);
    expect(moving.upgrade.choices).toEqual(heldOffer);
    expect(moving.playbackRate).toBe(1);
    expect(moving.simulationScale).toBe(1);

    for (const [width, height] of [[1280,800], [390,844], [1024,600]]) {
        await page.setViewportSize({ width: width!, height: height! });
        const cards = await page.locator(".bs-upgrade-card").all();
        let bottom = 0;
        for (const card of cards) {
            const box = (await card.boundingBox())!;
            expect(box.x).toBeGreaterThan(width! * .25);
            expect(box.x + box.width).toBeLessThan(width!);
            expect(box.y).toBeGreaterThanOrEqual(bottom);
            expect(box.y + box.height).toBeLessThan(height! - 70);
            bottom = box.y + box.height;
            await expect(card.locator("kbd")).toBeVisible();
        }
        const path = `output/playwright/upgrades-live-${width}.png`;
        await page.screenshot({ path });
        await testInfo.attach(`upgrades-${width}`, { path, contentType: "image/png" });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".bs-upgrade-card").first().focus();
    const beforeDash = await snapshot(page);
    await page.waitForFunction(after => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > after && state.dash.state === "ready" && state.position % 2 < .055;
    }, beforeDash.position, { polling: "raf", timeout: 5000 });
    await page.keyboard.press("Space");
    expect((await snapshot(page)).dash.accepted).toBe(beforeDash.dash.accepted + 1);
    expect((await snapshot(page)).upgrade.choices).toEqual(heldOffer);
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="paused"]')).toBeVisible();
    await expect(page.locator(".bs-upgrade-panel")).toBeHidden();
    const paused = await snapshot(page);
    await page.keyboard.press("1");
    await page.waitForTimeout(120);
    expect((await snapshot(page)).position).toBe(paused.position);
    expect((await snapshot(page)).upgrade).toEqual(paused.upgrade);
    await page.keyboard.press("Escape");
    await expect(page.locator(".bs-upgrade-panel")).toBeVisible();
    await page.locator('[data-upgrade-id="barrage"]').click();
    const resumed = await snapshot(page);
    expect(resumed.phase).toBe("playing");
    expect(resumed.playbackRate).toBe(1);
    expect(resumed.simulationScale).toBe(1);
    expect(resumed.upgrade.ranks.barrage).toBe(1);
    expect(resumed.upgrade.pending).toBe(0);
    expect(resumed.playerStats.effective.barrageCount).toBe(6);
    await expect(page.locator(".bs-upgrade-panel")).toBeHidden();

    let previous = resumed, normal = false, barrage = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (!normal || !barrage)) {
        const state = await aim(page);
        const difference = state.playerStats.metrics.shotsFired - previous.playerStats.metrics.shotsFired;
        if (difference > 0) {
            expect([1, 7]).toContain(difference);
            if (difference === 7) {
                barrage = true;
                expect(state.visuals.frame.beatIndex % 4).toBe(0);
                const ring = state.projectiles.filter(shot => shot.shooterId === 0);
                expect(ring.some(shot => shot.velocityX > 5)).toBe(true);
                expect(ring.some(shot => shot.velocityX < -5)).toBe(true);
                expect(ring.some(shot => shot.velocityZ > 5)).toBe(true);
                expect(ring.some(shot => shot.velocityZ < -5)).toBe(true);
            } else normal = true;
        }
        previous = state;
        await page.waitForTimeout(15);
    }
    expect(normal && barrage).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Restart session" }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    const fresh = await snapshot(page);
    expect(Object.entries(fresh.upgrade.ranks).every(([id, rank]) => rank === (id === "crit-damage" ? 1 : 0))).toBe(true);
    expect(fresh.playerStats.effective.barrageCount).toBe(0);
    expect(fresh.upgrade.pending).toBe(0);
    expect(fresh.upgrade.choices).toEqual([]);
    expect(fresh.playbackRate).toBe(1);
    expect(errors).toEqual([]);
});

test("a keyboard-selected ricochet waits at impact until the following beat", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?test=1");
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(page.locator(".bs-start-upgrade")).toBeVisible();
    await page.keyboard.press("2");
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    expect((await snapshot(page)).playerStats.effective.bounces).toBe(1);
    // Early waves contain one enemy per bar. Aim into an empty corner briefly
    // so a ricochet has a second living target, rather than clearing each wave.
    const corner = await page.evaluate(() => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const point = api.project([17, 0.55, 17])!;
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return { x: point[0] + bounds.left, y: point[1] + bounds.top };
    });
    await page.mouse.move(corner.x, corner.y);
    await expect.poll(async () => (await snapshot(page)).enemies.length, {
        timeout: 9000, intervals: [100],
    }).toBeGreaterThanOrEqual(3);
    let witnessed = false;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !witnessed) {
        const state = await aim(page);
        const shot = state.projectiles.find(item => item.waitingForBounce);
        if (shot && state.visuals.frame.beatPhase < 0.75 && state.enemies.some(enemy => !shot.hitEnemyIds.includes(enemy.id))) {
            expect(shot.hitEnemyIds).toHaveLength(1);
            expect(shot.velocityX).toBe(0);
            expect(shot.velocityZ).toBe(0);
            let waitingSamples = 0;
            const hopDeadline = Date.now() + 800;
            while (Date.now() < hopDeadline) {
                const current = await snapshot(page);
                const same = current.projectiles.find(item => item.id === shot.id);
                if (!same) break; // A very close next target can consume the shot within one frame.
                if (same.waitingForBounce) {
                    waitingSamples++;
                    expect(same.x).toBe(shot.x);
                    expect(same.z).toBe(shot.z);
                    expect(same.hitEnemyIds).toEqual(shot.hitEnemyIds);
                    expect(same.lastBounceBeat).toBe(shot.lastBounceBeat);
                } else {
                    expect(same.lastBounceBeat).toBe(shot.lastBounceBeat + 1);
                    expect(same.bouncesRemaining).toBe(0);
                    expect(same.hitEnemyIds).toEqual(shot.hitEnemyIds);
                    expect(Math.hypot(same.velocityX, same.velocityZ)).toBeCloseTo(32);
                    witnessed = waitingSamples > 1;
                    break;
                }
                await page.waitForTimeout(10);
            }
        }
        await page.waitForTimeout(15);
    }
    expect(witnessed, "a real collision must hold its projectile and release it on the next beat").toBe(true);
});


test("later level-ups queue behind a stable offer and held number keys cannot spend twice", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const first = await earnUpgrade(page);
    const queued = await collectUntil(page, state => state.upgrade.pending >= 2);
    expect(queued.phase).toBe("playing");
    expect(queued.position).toBeGreaterThan(first.position + 1);
    expect(queued.combat.kills).toBeGreaterThan(first.combat.kills);
    expect(queued.upgrade.choices).toEqual(first.upgrade.choices);
    expect(queued.upgrade.offeredLevel).toBe(2);
    await expect(page.locator('[data-value="upgrade-pending"]')).toHaveText(`${queued.upgrade.pending - 1} queued`);
    const choice = queued.upgrade.choices[0]!;
    await page.keyboard.down("1");
    const selected = await snapshot(page);
    expect(selected.upgrade.ranks[choice.id]).toBe(1);
    expect(selected.upgrade.pending).toBe(queued.upgrade.pending - 1);
    expect(selected.upgrade.offeredLevel).toBe(3);
    await page.keyboard.down("1"); // A held key emits repeat, not a fresh choice.
    expect((await snapshot(page)).upgrade).toEqual(selected.upgrade);
    await page.keyboard.up("1");
    const next = selected.upgrade.choices[1]!;
    await page.keyboard.press("Numpad2");
    const second = await snapshot(page);
    expect(second.upgrade.ranks[next.id]).toBe(selected.upgrade.ranks[next.id] + 1);
    expect(second.upgrade.pending).toBe(selected.upgrade.pending - 1);
    expect(second.phase).toBe("playing");
    expect(second.playbackRate).toBe(1);
    expect(second.simulationScale).toBe(1);
    const third = await collectUntil(page, state => state.upgrade.pending > 0);
    const last = third.upgrade.choices[2]!;
    await page.keyboard.press("3");
    expect((await snapshot(page)).upgrade.ranks[last.id]).toBe(third.upgrade.ranks[last.id] + 1);
});
