import { chooseStartingUpgrade } from "./starting-upgrade";
import { installUpgradeEntropy } from "./upgrade-entropy";
import { expect, test, type Page } from "./fixtures";
import type { UpgradeId } from "../src/upgrades";

type Point = { x: number; z: number };
interface Snapshot {
    phase: string;
    position: number;
    playbackRate: number;
    simulationScale: number;
    player: { position: Point };
    dash: {
        state: string; accepted: number;
        active?: { origin: Point; distance: number; startedAt: number; endsAt: number };
    };
    combat: { health: number; time: number; kills: number };
    enemies: (Point & { id: number })[];
    projectiles: (Point & {
        id: number; shooterId: number; waitingForBounce: boolean;
        bouncesRemaining: number; hitEnemyIds: number[]; lastBounceBeat: number;
        damage: number; initialDamage: number;
        velocityX: number; velocityZ: number;
    })[];
    experience: { level: number; drops: Point[]; totalXp: number };
    playerStats: {
        effective: {
            barrageCount: number; bounces: number;
            pickupRadiusMultiplier: number; dashDistance: number;
        };
        metrics: { shotsFired: number };
    };
    upgrade: {
        choices: { id: UpgradeId }[]; ranks: Record<UpgradeId, number>; pending: number;
        offeredLevel: number;
    };
    visuals: { frame: { beatIndex: number; beatPhase: number } };
}
interface FeedbackSample {
    position: number;
    beatIndex: number;
    cards: { id: string; selection: string; flash: number; opacity: number; renderedOpacity: number }[];
}
type InspectedWindow = Window & { __beatshooter: {
    snapshot(): Snapshot;
    project(point: [number, number, number]): [number, number] | null;
}; __upgradeFeedback?: FeedbackSample[] };
const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

const cardIds = (page: Page) => page.locator(".bs-upgrade-card").evaluateAll(cards =>
    cards.map(card => (card as HTMLElement).dataset.upgradeId));

async function expectNumericColors(page: Page, required: ("damage" | "health" | "utility")[] = []) {
    const cards = await page.locator(".bs-upgrade-card").evaluateAll(cards => cards.map(card => ({
        rarity: (card as HTMLElement).dataset.rarity,
        values: [...card.querySelectorAll<HTMLElement>(".bs-upgrade-value")].map(value => ({
            category: value.dataset.statCategory!, text: value.textContent!,
            color: getComputedStyle(value).color,
        })),
        prose: [...card.querySelectorAll<HTMLElement>(".bs-upgrade-detail, .bs-upgrade-description")].map(element => ({
            color: getComputedStyle(element).color,
            plain: [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent).join(""),
        })),
    })));
    const rgb = (color: string) => color.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number);
    const seen = new Set<string>();
    for (const card of cards) {
        expect(card.values.length).toBeGreaterThanOrEqual(card.rarity === "special" ? 1 : 2);
        for (const value of card.values) {
            seen.add(value.category);
            expect(value.text).toMatch(/^\d+(?:\.\d+)?(?:–\d+(?:\.\d+)?)?[%×]?$/);
            const [r, g, b] = rgb(value.color) as [number, number, number];
            if (value.category === "damage") {
                expect(r - g).toBeGreaterThan(40);
                expect(r - b).toBeGreaterThan(40);
            } else if (value.category === "health") {
                expect(g - r).toBeGreaterThan(40);
                expect(g - b).toBeGreaterThan(30);
            } else {
                expect(value.category).toBe("utility");
                expect(b - r).toBeGreaterThan(20);
                expect(r - g).toBeGreaterThan(20);
            }
        }
        for (const prose of card.prose) {
            expect(prose.plain).toMatch(/[a-z]/i);
            const channels = rgb(prose.color);
            expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(35);
            expect(card.values.every(value => value.color !== prose.color)).toBe(true);
        }
    }
    for (const category of required) expect(seen.has(category), `${category} values must be rendered`).toBe(true);
}

async function expectConfirmation(page: Page, selected: UpgradeId, choices: readonly { id: UpgradeId }[]) {
    const panel = page.locator(".bs-upgrade-panel");
    await expect(panel).toHaveAttribute("data-selection-state", "confirming");
    expect(await cardIds(page)).toEqual(choices.map(choice => choice.id));
    await expect(panel.locator(`[data-upgrade-id="${selected}"]`)).toHaveAttribute("data-selection", "selected");
    await expect(panel.locator('[data-selection="dismissed"]')).toHaveCount(2);
    await expect(panel.locator(".bs-upgrade-card:disabled")).toHaveCount(3);
}

async function readyOffer(page: Page) {
    const panel = page.locator(".bs-upgrade-panel");
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-selection-state", "confirming");
    await expect(panel.locator(".bs-upgrade-card:enabled")).toHaveCount(3);
}

async function recordFeedback(page: Page) {
    await page.evaluate(() => {
        const target = window as unknown as InspectedWindow;
        target.__upgradeFeedback = [];
        let seen = false;
        const sample = () => {
            const panel = document.querySelector<HTMLElement>(".bs-upgrade-panel");
            const confirming = panel?.dataset.selectionState === "confirming";
            if (seen && !confirming) return;
            if (confirming) {
                seen = true;
                const state = target.__beatshooter.snapshot();
                target.__upgradeFeedback!.push({
                    position: state.position, beatIndex: state.visuals.frame.beatIndex,
                    cards: [...panel.querySelectorAll<HTMLElement>(".bs-upgrade-card")].map(card => {
                        const style = getComputedStyle(card);
                        return {
                            id: card.dataset.upgradeId!, selection: card.dataset.selection!,
                            flash: Number(style.getPropertyValue("--upgrade-flash")),
                            opacity: Number(style.getPropertyValue("--upgrade-opacity")),
                            renderedOpacity: Number(style.opacity),
                        };
                    }),
                });
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
}

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
        await expectNumericColors(page, ["damage", "utility"]);
        const before = await snapshot(page);
        expect(before.phase).toBe("starting");
        expect(before.playbackRate).toBe(0);
        expect(before.experience.level).toBe(1);
        expect(before.upgrade.pending).toBe(1);
        expect(before.playerStats.effective.pickupRadiusMultiplier).toBe(1);
        expect(before.playerStats.effective.dashDistance).toBe(3.6);
        await page.waitForTimeout(250);
        await page.keyboard.press("Escape");
        expect((await snapshot(page)).position).toBe(before.position);
        expect((await snapshot(page)).phase).toBe("starting");
        expect(await page.locator('[data-screen="hud"]').evaluate(el => (el as HTMLElement).inert)).toBe(true);
        await page.screenshot({ path: `output/playwright/starting-upgrade-${viewport.width}.png` });
        const chosenId = viewport.width > 800 ? "dash-distance" : "pickup-radius";
        const chosenIndex = before.upgrade.choices.findIndex(choice => choice.id === chosenId);
        expect(chosenIndex).toBeGreaterThanOrEqual(0);
        const chosen = before.upgrade.choices[chosenIndex]!;
        await page.keyboard.press(String(chosenIndex + 1));
        await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
        const started = await snapshot(page);
        expect(started.position).toBeLessThan(0);
        expect(started.upgrade.ranks[chosen.id]).toBe(1);
        expect(started.upgrade.pending).toBe(0);
        expect(started.experience.totalXp).toBe(0);
        expect(started.playerStats.effective.pickupRadiusMultiplier).toBe(chosenId === "pickup-radius" ? 1.25 : 1);
        expect(started.playerStats.effective.dashDistance).toBe(chosenId === "dash-distance" ? 4.2 : 3.6);
        await expectConfirmation(page, chosen.id, before.upgrade.choices);
        await expect(panel.locator('[data-selection="selected"]')).toHaveAttribute("aria-label", /selected\. Rank 1\./);
        const quit = panel.locator(".bs-start-quit");
        await page.keyboard.press("Tab");
        await expect(quit).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(quit).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(quit).toBeFocused();
        await page.keyboard.press("Escape");
        expect((await snapshot(page)).phase).toBe("playing");
        await expect(panel).toBeVisible();
        await page.keyboard.press("1");
        expect((await snapshot(page)).upgrade.ranks).toEqual(started.upgrade.ranks);
        await expect(panel).toBeHidden();
        if (chosenId === "dash-distance") {
            await page.waitForFunction(() => {
                const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
                return state.position >= 0 && state.dash.state === "ready" && state.position % 0.5 < 0.05;
            }, undefined, { polling: "raf", timeout: 5000 });
            await page.keyboard.down("KeyD");
            await page.keyboard.press("Space");
            const dashing = await snapshot(page);
            await page.keyboard.up("KeyD");
            expect(dashing.dash.accepted).toBe(1);
            expect(dashing.dash.active?.distance).toBe(4.2);
            await expect.poll(async () => (await snapshot(page)).dash.active).toBeUndefined();
            const dashed = await snapshot(page);
            const origin = dashing.dash.active!.origin;
            const travelled = Math.hypot(dashed.player.position.x - origin.x, dashed.player.position.z - origin.z);
            expect(travelled).toBeGreaterThan(3.5);
            expect(travelled).toBeLessThanOrEqual(4.25);
        }
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Restart session", exact: true }).click();
        await expect(panel).toBeVisible();
        await expect(panel).not.toHaveAttribute("data-selection-state", "confirming");
        await expect(panel.locator(".bs-upgrade-card:enabled")).toHaveCount(3);
        const fresh = await snapshot(page);
        expect(Object.values(fresh.upgrade.ranks).every(rank => rank === 0)).toBe(true);
        expect(fresh.upgrade.pending).toBe(1);
        expect(fresh.playerStats.effective.pickupRadiusMultiplier).toBe(1);
        expect(fresh.playerStats.effective.dashDistance).toBe(3.6);
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

/** Follow normal earned offers until a specific weapon upgrade is available. */
async function earnSpecificUpgrade(page: Page, id: UpgradeId, demo = true) {
    let state = await earnUpgrade(page, demo);
    for (let offer = 0; offer < 8; offer++) {
        await readyOffer(page);
        await expectNumericColors(page);
        if (state.upgrade.choices.some(choice => choice.id === id)) return state;
        // Preserve default firing counts and bounce behavior while collecting
        // the next offer. All selections still go through the visible cards.
        const preference: UpgradeId[] = ["regeneration", "health", "pickup-radius", "dash-distance", "crit-damage", "crit-chance", "damage"];
        const fallback = preference.find(candidate => state.upgrade.choices.some(choice => choice.id === candidate));
        expect(fallback, `a non-projectile fallback must be available while finding ${id}`).toBeDefined();
        await page.locator(`.bs-upgrade-card[data-upgrade-id="${fallback}"]`).click();
        await expect(page.locator(".bs-upgrade-panel")).not.toHaveAttribute("data-selection-state", "confirming");
        state = await collectUntil(page, state => state.upgrade.pending > 0);
    }
    throw new Error(`Ordinary earned offers did not contain ${id}.`);
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
    test.setTimeout(110_000);
    // With the rare-card roll, this seed offers Pickup Radius first and Barrage
    // at the first earned level, leaving time to exercise the full UI lifecycle.
    await installUpgradeEntropy(page, [19]);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    const first = await earnSpecificUpgrade(page, "barrage");
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
        const panel = page.locator(".bs-upgrade-panel");
        const panelBox = (await panel.boundingBox())!;
        const beatBox = (await page.locator(".bs-hud-bottom .bs-hud-beat").boundingBox())!;
        const experienceBox = (await page.locator(".bs-experience").boundingBox())!;
        expect(panelBox.x).toBeGreaterThanOrEqual(0);
        expect(panelBox.y).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width!);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(height!);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(beatBox.y);
        expect(panelBox.y).toBeGreaterThanOrEqual(experienceBox.y + experienceBox.height);
        expect(panelBox.width).toBeGreaterThanOrEqual(Math.min(500, width! - 40));
        const overflow = await panel.evaluate(element => ({
            scroll: element.scrollHeight, client: element.clientHeight,
            horizontal: element.scrollWidth - element.clientWidth,
            overflowY: getComputedStyle(element).overflowY,
        }));
        expect(overflow.horizontal).toBeLessThanOrEqual(1);
        if (height! <= 620) {
            expect(overflow.scroll).toBeGreaterThan(overflow.client);
            expect(overflow.overflowY).toBe("auto");
        }
        const cards = await page.locator(".bs-upgrade-card").all();
        for (const card of cards) {
            await card.scrollIntoViewIfNeeded();
            const box = (await card.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
            expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
            expect(box.y).toBeGreaterThanOrEqual(panelBox.y - 1);
            expect(box.y + box.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
            const text = await card.evaluate(element => {
                const read = (selector: string) => {
                    const node = element.querySelector<HTMLElement>(selector)!;
                    return {
                        size: parseFloat(getComputedStyle(node).fontSize),
                        clipped: node.scrollWidth > node.clientWidth + 1,
                    };
                };
                return {
                    name: read(".bs-upgrade-name"),
                    detail: read(".bs-upgrade-detail"),
                    description: read(".bs-upgrade-description"),
                };
            });
            expect(text.name.size).toBeGreaterThanOrEqual(width! <= 800 ? 27 : 30);
            expect(text.detail.size).toBeGreaterThanOrEqual(width! <= 800 ? 14 : 15);
            expect(text.description.size).toBeGreaterThanOrEqual(14);
            expect(Object.values(text).every(value => !value.clipped)).toBe(true);
            await expect(card.locator(".bs-upgrade-description")).toBeVisible();
            await expect(card.locator("kbd")).toBeVisible();
        }
        await panel.evaluate(element => element.scrollTo({ top: 0, behavior: "instant" }));
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
    await expectConfirmation(page, "barrage", heldOffer);
    await expect(page.locator(".bs-upgrade-panel")).toBeHidden();

    let previous = await snapshot(page), normal = false, barrage = false;
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
    expect(Object.entries(fresh.upgrade.ranks).every(([id, rank]) => rank === (id === "pickup-radius" ? 1 : 0))).toBe(true);
    expect(fresh.playerStats.effective.barrageCount).toBe(0);
    expect(fresh.upgrade.pending).toBe(0);
    expect(fresh.upgrade.choices).toEqual([]);
    expect(fresh.playbackRate).toBe(1);
    expect(errors).toEqual([]);
});

test("a keyboard-selected ricochet waits at impact until the following beat", async ({ page }, testInfo) => {
    // The first earned offer contains Ricochet and green regeneration values.
    await installUpgradeEntropy(page, [21]);
    await page.setViewportSize({ width: 1280, height: 800 });
    const offer = await earnSpecificUpgrade(page, "bounce", false);
    await expectNumericColors(page, ["damage", "health"]);
    const colorPath = "output/playwright/upgrade-health-values.png";
    await page.screenshot({ path: colorPath });
    await testInfo.attach("upgrade-health-values", { path: colorPath, contentType: "image/png" });
    const choiceIndex = offer.upgrade.choices.findIndex(choice => choice.id === "bounce");
    await page.keyboard.press(String(choiceIndex + 1));
    expect((await snapshot(page)).playerStats.effective.bounces).toBe(1);
    await expect(page.locator(".bs-upgrade-panel")).not.toHaveAttribute("data-selection-state", "confirming");
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
            expect(shot.damage).toBe(shot.initialDamage);
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
                    expect(same.damage).toBe(shot.damage);
                } else {
                    expect(same.lastBounceBeat).toBe(shot.lastBounceBeat + 1);
                    expect(same.bouncesRemaining).toBe(0);
                    expect(same.damage).toBe(Math.round(shot.initialDamage * 0.7));
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


test("queued upgrades wait for beat-synced selection feedback and ignore extra presses", async ({ page }, testInfo) => {
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
    // Choose early in a beat so the next-beat flash is observable after the
    // immediate receipt and pause checks, rather than racing a boundary.
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.visuals.frame.beatPhase > 0.05 && state.visuals.frame.beatPhase < 0.2;
    }, undefined, { polling: "raf", timeout: 2500 });
    const beforeSelection = await snapshot(page);
    await recordFeedback(page);
    await page.keyboard.down("1");
    const selected = await snapshot(page);
    expect(selected.upgrade.ranks[choice.id]).toBe(1);
    expect(selected.upgrade.pending).toBe(beforeSelection.upgrade.pending - 1);
    expect(selected.upgrade.offeredLevel).toBe(3);
    await expectConfirmation(page, choice.id, queued.upgrade.choices);
    await page.keyboard.down("1"); // A held key emits repeat, not a fresh choice.
    await page.keyboard.up("1");
    // Even a new key press belongs to the visible receipt, not the queued
    // offer which the simulation has already prepared behind it.
    await page.keyboard.press("Numpad2");
    expect((await snapshot(page)).upgrade.ranks).toEqual(selected.upgrade.ranks);
    expect(await cardIds(page)).toEqual(queued.upgrade.choices.map(item => item.id));
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="paused"]')).toBeVisible();
    await expect(page.locator(".bs-upgrade-panel")).toBeHidden();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const held = await snapshot(page);
    const readReceipt = () => page.locator(".bs-upgrade-panel").evaluate(panel => ({
        state: (panel as HTMLElement).dataset.selectionState,
        cards: [...panel.querySelectorAll<HTMLButtonElement>(".bs-upgrade-card")].map(card => ({
            id: card.dataset.upgradeId, selection: card.dataset.selection,
            disabled: card.disabled, style: card.getAttribute("style"),
        })),
    }));
    const heldReceipt = await readReceipt();
    expect(heldReceipt.state).toBe("confirming");
    expect(heldReceipt.cards).toHaveLength(3);
    await page.keyboard.press("3");
    await page.waitForTimeout(220);
    const frozen = await snapshot(page);
    expect(frozen.position).toBe(held.position);
    expect(frozen.upgrade).toEqual(held.upgrade);
    expect(await readReceipt()).toEqual(heldReceipt);
    await page.keyboard.press("Escape");
    await expect(page.locator(".bs-upgrade-panel")).toBeVisible();
    await page.waitForFunction(() => {
        const selected = document.querySelector<HTMLElement>('.bs-upgrade-card[data-selection="selected"]');
        return selected && Number(getComputedStyle(selected).getPropertyValue("--upgrade-flash")) > 0.4;
    }, undefined, { polling: "raf", timeout: 2500 });
    const feedbackPath = "output/playwright/upgrade-selection-feedback.png";
    await page.screenshot({ path: feedbackPath });
    await testInfo.attach("upgrade-selection-feedback", { path: feedbackPath, contentType: "image/png" });
    await readyOffer(page);
    const feedback = await page.evaluate(() => (window as unknown as InspectedWindow).__upgradeFeedback!);
    expect(feedback.length).toBeGreaterThan(3);
    const flash = feedback.filter(frame => frame.cards.some(card => card.selection === "selected" && card.flash > 0.05));
    expect(flash.length).toBeGreaterThan(0);
    expect(flash.every(frame => frame.beatIndex > selected.visuals.frame.beatIndex)).toBe(true);
    expect(feedback.some(frame => {
        const chosen = frame.cards.find(card => card.selection === "selected")!;
        const others = frame.cards.filter(card => card.selection === "dismissed");
        return others.length === 2 && others.every(card => card.opacity < 0.1 && card.renderedOpacity < 0.1)
            && chosen.opacity > 0.5;
    })).toBe(true);
    expect(feedback.some(frame => frame.cards.some(card =>
        card.selection === "selected" && card.opacity < 0.25 && card.renderedOpacity < 0.25))).toBe(true);
    const nextOffer = await snapshot(page);
    expect(nextOffer.upgrade.ranks).toEqual(selected.upgrade.ranks);
    expect(await cardIds(page)).toEqual(nextOffer.upgrade.choices.map(item => item.id));
    const next = nextOffer.upgrade.choices[1]!;
    await page.keyboard.press("Numpad2");
    const second = await snapshot(page);
    expect(second.upgrade.ranks[next.id]).toBe(nextOffer.upgrade.ranks[next.id] + 1);
    expect(second.upgrade.pending).toBe(nextOffer.upgrade.pending - 1);
    expect(second.phase).toBe("playing");
    expect(second.playbackRate).toBe(1);
    expect(second.simulationScale).toBe(1);
    await expectConfirmation(page, next.id, nextOffer.upgrade.choices);
    await expect(page.locator(".bs-upgrade-panel")).not.toHaveAttribute("data-selection-state", "confirming");
    const third = await collectUntil(page, state => state.upgrade.pending > 0);
    await readyOffer(page);
    const last = third.upgrade.choices[2]!;
    await page.keyboard.press("3");
    expect((await snapshot(page)).upgrade.ranks[last.id]).toBe(third.upgrade.ranks[last.id] + 1);
    await expectConfirmation(page, last.id, third.upgrade.choices);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect(page.locator(".bs-start-upgrade")).toBeVisible();
    await expect(page.locator(".bs-upgrade-panel")).not.toHaveAttribute("data-selection-state", "confirming");
    await expect(page.locator(".bs-upgrade-card[data-selection]")).toHaveCount(0);
    await expect(page.locator(".bs-upgrade-card:enabled")).toHaveCount(3);
    const reset = await snapshot(page);
    expect(reset.phase).toBe("starting");
    expect(reset.upgrade.pending).toBe(1);
    expect(Object.values(reset.upgrade.ranks).every(rank => rank === 0)).toBe(true);
});
