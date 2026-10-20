import { expect, test, type Page } from "playwright/test";
import type { UpgradeId } from "../src/upgrades";

type Point = { x: number; z: number };
interface Snapshot {
    phase: string;
    position: number;
    playbackRate: number;
    simulationScale: number;
    player: { position: Point };
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
        progress: number; target?: number; protected: boolean;
    };
    visuals: { frame: { beatIndex: number; beatPhase: number } };
}
type SlowdownSample = {
    state: Snapshot; time: number; cardsDisabled: boolean;
    visibility: DocumentVisibilityState; focused: boolean;
};
type InspectedWindow = Window & { __upgradeSamples?: SlowdownSample[]; __beatshooter: {
    snapshot(): Snapshot;
    project(point: [number, number, number]): [number, number] | null;
} };
const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

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
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    // Capture every rendered frame in-page: a 180–250 ms transition is too
    // short to measure reliably through repeated automation round trips.
    await page.evaluate(() => {
        const inspected = window as unknown as InspectedWindow;
        inspected.__upgradeSamples = [];
        const record = (time: number) => {
            const state = inspected.__beatshooter.snapshot();
            if (state.phase === "upgrade-slowing" || state.phase === "upgrading") {
                inspected.__upgradeSamples!.push({
                    state, time,
                    visibility: document.visibilityState, focused: document.hasFocus(),
                    cardsDisabled: [...document.querySelectorAll<HTMLButtonElement>(".bs-upgrade-card")]
                        .every(card => card.disabled),
                });
            }
            if (state.phase === "playing" || state.phase === "upgrade-slowing") requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
    });
    const held = new Set<string>();
    const deadline = Date.now() + 35_000;
    try {
        while (Date.now() < deadline) {
            const state = await aim(page);
            if (state.phase === "upgrade-slowing" || state.phase === "upgrading") return state;
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

test("level-up slows the demo, freezes three cards, and resumes a main-beat barrage", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await earnUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="upgrading"]')).toBeVisible();
    const samples = await page.evaluate(() => (window as unknown as InspectedWindow).__upgradeSamples!);
    await testInfo.attach("upgrade-slowdown-samples", {
        contentType: "application/json",
        body: JSON.stringify(samples.map(({ state, time, cardsDisabled, visibility, focused }) => ({
            time, phase: state.phase, playbackRate: state.playbackRate,
            simulationScale: state.simulationScale, progress: state.upgrade.progress,
            position: state.position, target: state.upgrade.target,
            combatTime: state.combat.time, cardsDisabled, visibility, focused,
        })), null, 2),
    });
    const first = samples[0]!.state;
    expect(first.phase).toBe("upgrade-slowing");
    expect(first.upgrade.protected).toBe(true);
    const slowing = samples.filter(sample => sample.state.phase === "upgrade-slowing").map(sample => sample.state);
    expect(slowing.length).toBeGreaterThanOrEqual(3);
    expect(samples.at(-1)!.state.phase).toBe("upgrading");
    expect(samples.at(-1)!.time - samples[0]!.time).toBeLessThanOrEqual(300);
    for (const sample of samples) {
        if (sample.state.phase === "upgrade-slowing") expect(sample.cardsDisabled).toBe(true);
    }
    expect(slowing[0]!.playbackRate).toBeGreaterThan(slowing.at(-1)!.playbackRate);
    // Audio automation continues between rendered frames. A short transition
    // need not render a frame near its final 0.12 rate; validate every sampled
    // point against the rate/progress curve and the exact paused endpoint.
    for (const state of slowing) {
        if (state.playbackRate > 0) {
            const expectedRate = Math.sqrt(1 - (1 - 0.12 ** 2) * state.upgrade.progress);
            expect(state.playbackRate).toBeCloseTo(expectedRate, 1);
        }
    }
    for (let i = 1; i < slowing.length; i++) {
        expect(slowing[i]!.position).toBeGreaterThanOrEqual(slowing[i - 1]!.position);
        expect(slowing[i]!.upgrade.progress).toBeGreaterThanOrEqual(slowing[i - 1]!.upgrade.progress);
        expect(slowing[i]!.playbackRate).toBeLessThanOrEqual(slowing[i - 1]!.playbackRate);
        if (slowing[i]!.playbackRate > 0) {
            expect(slowing[i]!.simulationScale).toBeCloseTo(slowing[i]!.playbackRate, 1);
        } else {
            // AudioContext can reach its scheduled stop between ObserveMusic
            // and this rAF observer. Rate jumps from 0.12 to zero; the stored
            // simulation scale is finalized by the next engine observation.
            expect(slowing[i]!.upgrade.progress).toBe(1);
            expect(slowing[i]!.simulationScale).toBeGreaterThanOrEqual(0.12);
            expect(slowing[i]!.simulationScale).toBeLessThanOrEqual(slowing[i - 1]!.simulationScale);
            expect(slowing[i]!.position).toBeLessThanOrEqual(slowing[i]!.upgrade.target!);
            const next = samples[samples.findIndex(sample => sample.state === slowing[i]) + 1]!.state;
            expect(next.phase).toBe("upgrading");
            expect(next.position).toBeCloseTo(slowing[i]!.upgrade.target!, 8);
            expect(next.combat.time).toBe(slowing[i]!.combat.time);
        }
        expect(slowing[i]!.combat.health).toBe(first.combat.health);
    }
    await expect(page.locator('.bs-ui[data-phase="upgrading"]')).toBeVisible();
    await expect(page.locator(".bs-upgrade-card")).toHaveCount(3);
    await expect(page.locator(".bs-upgrade-card").first()).toBeEnabled();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const frozen = await snapshot(page);
    expect(frozen.position).toBeCloseTo(first.upgrade.target!, 8);
    expect(frozen.playbackRate).toBe(0);
    expect(new Set(frozen.upgrade.choices.map(choice => choice.id)).size).toBe(3);
    await page.waitForTimeout(300);
    const still = await snapshot(page);
    expect(still.position).toBe(frozen.position);
    expect(still.combat).toEqual(frozen.combat);
    expect(still.enemies).toEqual(frozen.enemies);
    expect(still.projectiles).toEqual(frozen.projectiles);
    expect(still.player).toEqual(frozen.player);
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="upgrading"]')).toBeVisible();
    expect(await page.locator('[data-screen="hud"]').evaluate(element => (element as HTMLElement).inert)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.closest(".bs-upgrade-dialog") !== null)).toBe(true);
    const desktop = "output/playwright/upgrades-game-desktop.png";
    await page.screenshot({ path: desktop });
    await testInfo.attach("upgrades-desktop", { path: desktop, contentType: "image/png" });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const card of await page.locator(".bs-upgrade-card").all()) {
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    }
    const mobile = "output/playwright/upgrades-game-mobile.png";
    await page.screenshot({ path: mobile });
    await testInfo.attach("upgrades-mobile", { path: mobile, contentType: "image/png" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('[data-upgrade-id="barrage"]').click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.waitForTimeout(200);
    const resumed = await snapshot(page);
    expect(resumed.playbackRate).toBe(1);
    expect(resumed.simulationScale).toBe(1);
    expect(resumed.upgrade.ranks.barrage).toBe(1);
    expect(resumed.upgrade.pending).toBe(0);
    expect(resumed.upgrade.protected).toBe(false);
    expect(resumed.playerStats.effective.barrageCount).toBe(6);
    const musicAdvance = resumed.position - frozen.position;
    const simulationAdvance = resumed.combat.time - frozen.combat.time;
    expect(musicAdvance).toBeGreaterThan(0.1);
    // Fixed integration can differ by a frame, but each card must not introduce
    // the ordinary 40 ms transport lead-in as extra unaccompanied simulation.
    expect(Math.abs(simulationAdvance - musicAdvance)).toBeLessThan(0.035);

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
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    const fresh = await snapshot(page);
    expect(Object.values(fresh.upgrade.ranks).every(rank => rank === 0)).toBe(true);
    expect(fresh.playerStats.effective.barrageCount).toBe(0);
    expect(fresh.upgrade.pending).toBe(0);
    expect(fresh.upgrade.choices).toEqual([]);
    expect(fresh.playbackRate).toBe(1);
    expect(errors).toEqual([]);
});

test("a keyboard-selected ricochet waits at impact until the following beat", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await earnUpgrade(page, false);
    await expect(page.locator('.bs-ui[data-phase="upgrading"]')).toBeVisible();
    const offered = await snapshot(page);
    const slot = offered.upgrade.choices.findIndex(choice => choice.id === "bounce");
    expect(slot).toBeGreaterThanOrEqual(0);
    await page.keyboard.press(String(slot + 1));
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
