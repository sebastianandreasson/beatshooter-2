import { chooseStartingUpgrade } from "./starting-upgrade";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "playwright/test";

type Point = { x: number; z: number };
interface PlaySnapshot {
    phase: string;
    position: number;
    pending: number;
    upgrade: { pending: number };
    sounds: number;
    entityCount: number;
    player: { position: Point; target: Point; bodyY: number };
    combat: { health: number; score: number; kills: number; enemies: number };
    targets: Point[];
}
interface PlayInspection {
    snapshot(): PlaySnapshot;
    project(point: [number, number, number]): [number, number] | null;
}
type PlayWindow = Window & { __beatshooter: PlayInspection };

async function boot(page: Page): Promise<void> {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as PlayWindow).__beatshooter));
}

test("the full 72-second demo can be won through normal movement and aiming", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await boot(page);
    await page.getByRole("button", { name: "Enter the arena" }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible({ timeout: 20_000 });

    // A reproducible ordinary playthrough: circle inside the spawn perimeter and
    // aim at the nearest enemy. Every action is a browser keyboard/pointer event.
    // Inspection reads positions only; no health, timer, or result is changed.
    const route: Point[] = [
        { x: 8, z: 0 }, { x: 8, z: 8 }, { x: -8, z: 8 },
        { x: -8, z: -8 }, { x: 8, z: -8 },
    ];
    let waypoint = 0;
    const held = new Set<string>();
    const checkpoints: object[] = [];
    let nextCheckpoint = 0;
    const deadline = Date.now() + 105_000;
    try {
        while (Date.now() < deadline) {
            const observed = await page.evaluate(() => {
                const api = (window as unknown as PlayWindow).__beatshooter;
                const state = api.snapshot();
                const player = state.player.position;
                const nearest = [...state.targets].sort((a, b) =>
                    Math.hypot(a.x - player.x, a.z - player.z)
                    - Math.hypot(b.x - player.x, b.z - player.z),
                )[0];
                const projected = nearest && api.project([nearest.x, 0.55, nearest.z]);
                const bounds = document.querySelector("canvas")!.getBoundingClientRect();
                return {
                    state,
                    pointer: projected ? {
                        x: projected[0] + bounds.left, y: projected[1] + bounds.top,
                    } : null,
                };
            });
            const state = observed.state;
            if (state.position >= nextCheckpoint) {
                const checkpoint = { position: state.position, ...state.combat, player: state.player.position };
                checkpoints.push(checkpoint);
                console.log("Demo checkpoint:", JSON.stringify(checkpoint));
                nextCheckpoint += 12;
            }
            if (state.phase === "results") break;
            if (state.upgrade.pending > 0) await page.keyboard.press("1");
            expect(state.phase, "normal play should remain active until the result").toBe("playing");
            const player = state.player.position;
            let target = route[waypoint]!;
            if (Math.hypot(target.x - player.x, target.z - player.z) < 0.8) {
                waypoint++;
                if (waypoint >= route.length) waypoint = 1;
                target = route[waypoint]!;
            }
            const dx = target.x - player.x;
            const dz = target.z - player.z;
            const desired = new Set<string>();
            if (dx > 0.35) desired.add("KeyD");
            if (dx < -0.35) desired.add("KeyA");
            if (dz > 0.35) desired.add("KeyS");
            if (dz < -0.35) desired.add("KeyW");
            for (const key of held) {
                if (!desired.has(key)) { await page.keyboard.up(key); held.delete(key); }
            }
            for (const key of desired) {
                if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
            }
            if (observed.pointer) await page.mouse.move(observed.pointer.x, observed.pointer.y);
            await page.waitForTimeout(100);
        }
    } finally {
        for (const key of held) await page.keyboard.up(key);
        const checkpointPath = testInfo.outputPath("demo-playthrough-checkpoints.json");
        await writeFile(checkpointPath, JSON.stringify(checkpoints, null, 2));
        await testInfo.attach("demo-playthrough-checkpoints", {
            path: checkpointPath, contentType: "application/json",
        });
    }
    await expect(page.locator('[data-screen="results"]')).toBeVisible();
    const result = await page.evaluate(() => (window as unknown as PlayWindow).__beatshooter.snapshot());
    console.log("Full demo result:", JSON.stringify({ position: result.position, ...result.combat, player: result.player.position }));
    await expect(page.locator('[data-value="result-title"]')).toHaveText("Track complete");
    await expect(page.locator(".damage-layer")).toBeHidden();
    expect(result.position).toBeCloseTo(72, 2);
    expect(result.combat.health).toBeGreaterThan(0);
    expect(result.combat.kills).toBeGreaterThan(0);
    expect(result.combat.score).toBeGreaterThan(0);
    expect(result.pending).toBe(0);
    expect(result.sounds).toBe(0);
    expect(errors).toEqual([]);
    const screenshotPath = testInfo.outputPath("demo-complete.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("demo-complete", { path: screenshotPath, contentType: "image/png" });
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    expect((await page.evaluate(() => (window as unknown as PlayWindow).__beatshooter.snapshot())).entityCount).toBe(0);
});

test.describe("high-density viewport", () => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 1000, height: 700 } });

    test("the physics boundary holds and pointer projection remains correct at DPR 2 after resize", async ({ page }) => {
        test.setTimeout(60_000);
        await boot(page);
        expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
        await page.getByRole("button", { name: "Practice", exact: true }).click();
        await chooseStartingUpgrade(page);
        await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
        await page.keyboard.down("KeyD");
        try {
            await expect.poll(async () => page.evaluate(() =>
                (window as unknown as PlayWindow).__beatshooter.snapshot().player.position.x,
            ), { timeout: 10_000 }).toBeGreaterThan(17.2);
            await page.waitForTimeout(450);
            const state = await page.evaluate(() => (window as unknown as PlayWindow).__beatshooter.snapshot());
            expect(state.player.position.x).toBeLessThan(17.5);
            expect(state.player.bodyY).toBeCloseTo(0.55, 4);
        } finally {
            await page.keyboard.up("KeyD");
        }
        for (const viewport of [{ width: 1000, height: 700 }, { width: 900, height: 650 }]) {
            await page.setViewportSize(viewport);
            const pointer = { x: viewport.width * 0.68, y: viewport.height * 0.55 };
            await page.mouse.move(pointer.x, pointer.y);
            await expect.poll(async () => page.evaluate((pointer) => {
                const api = (window as unknown as PlayWindow).__beatshooter;
                const target = api.snapshot().player.target;
                const projected = api.project([target.x, 0.55, target.z]);
                const bounds = document.querySelector("canvas")!.getBoundingClientRect();
                return projected ? Math.hypot(
                    projected[0] + bounds.left - pointer.x,
                    projected[1] + bounds.top - pointer.y,
                ) : Infinity;
            }, pointer)).toBeLessThan(2);
        }
    });
});
