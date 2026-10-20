import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";

interface MeshWitness {
    position: { x: number; y: number; z: number };
    rotation: { y: number; w: number };
    scale: { x: number; y: number; z: number };
    material: number;
}
interface EnemyWitness {
    id: number;
    kind: "chaser" | "spinner" | "ranger";
    heading: number;
    spawnBar: number;
    x: number;
    z: number;
    health: number;
    body?: MeshWitness;
    accents: MeshWitness[];
}
interface ProjectileWitness {
    id: number;
    shooterId: number;
    collisionMask: number;
    x: number;
    z: number;
    velocityX: number;
    velocityZ: number;
    remainingLifetime: number;
    mesh?: MeshWitness;
}
interface Snapshot {
    phase: string;
    generation: number;
    position: number;
    entityCount: number;
    bodyCount: number;
    player: { position: { x: number; z: number } };
    enemies: EnemyWitness[];
    projectiles: ProjectileWitness[];
    presentation: { enemyAccentGroups: number; enemyAccentCount: number; projectiles: number };
}
type InspectedWindow = Window & {
    __beatshooter: {
        snapshot(): Snapshot;
        project(point: [number, number, number]): [number, number] | null;
    };
};
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as InspectedWindow).__beatshooter.snapshot());

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.setTimeout(60_000);

test("new enemies show distinct silhouettes and main-beat attacks, freeze on pause, and clear their meshes on retry", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
    const initial = await snapshot(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    // Aim into an empty corner so the first shooters survive long enough to
    // witness their normal attack and lifecycle through real browser controls.
    await page.mouse.move(1150, 90);
    await page.waitForFunction(() => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.position > 2.2 && s.enemies.some(enemy => enemy.kind === "spinner");
    }, undefined, { polling: "raf", timeout: 10_000 });
    const first = await snapshot(page);
    const spinner = first.enemies.find(enemy => enemy.kind === "spinner")!;
    expect(spinner.spawnBar).toBe(1);
    expect(spinner.accents).toHaveLength(3);
    expect(first.projectiles.filter(shot => shot.shooterId === spinner.id)).toHaveLength(0);

    await page.waitForFunction(id => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.position > 4.02 && s.enemies.some(enemy => enemy.kind === "ranger")
            && s.projectiles.filter(shot => shot.shooterId === id).length === 3;
    }, spinner.id, { polling: "raf", timeout: 10_000 });
    // Freeze the three-ray volley immediately: the ranger now finishes its
    // arrival half a second after the volley, and screenshot readback can let
    // an outward-moving ray reach the arena boundary before it is witnessed.
    await pause(page);
    const held = await snapshot(page);
    const rotated = held.enemies.find(enemy => enemy.id === spinner.id)!;
    const ranger = held.enemies.find(enemy => enemy.kind === "ranger")!;
    expect(rotated.x).toBeCloseTo(spinner.x, 3);
    expect(rotated.z).toBeCloseTo(spinner.z, 3);
    expect(Math.atan2(Math.sin(rotated.heading - spinner.heading), Math.cos(rotated.heading - spinner.heading)))
        .toBeCloseTo(Math.PI / 6, 5);
    expect(ranger.accents).toHaveLength(3);
    expect(ranger.body).toBeDefined();
    expect(rotated.body).toBeDefined();
    expect(ranger.body!.material).not.toBe(rotated.body!.material);
    const shots = held.projectiles.filter(shot => shot.shooterId === spinner.id);
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
        expect(shot.collisionMask).toBe(1);
        expect(shot.mesh).toBeDefined();
        expect(shot.mesh!.scale.x).toBeGreaterThan(0.14);
    }
    for (let index = 0; index < shots.length; index++) {
        const a = shots[index]!, b = shots[(index + 1) % shots.length]!;
        const dot = (a.velocityX * b.velocityX + a.velocityZ * b.velocityZ)
            / (Math.hypot(a.velocityX, a.velocityZ) * Math.hypot(b.velocityX, b.velocityZ));
        expect(dot).toBeCloseTo(-0.5, 5);
    }
    const playerShot = held.projectiles.find(shot => shot.collisionMask === 2 && shot.mesh);
    expect(playerShot).toBeDefined();
    expect(shots[0]!.mesh!.material).not.toBe(playerShot!.mesh!.material);
    await page.waitForTimeout(350);
    const later = await snapshot(page);
    expect(later.position).toBe(held.position);
    expect(later.enemies).toEqual(held.enemies);
    expect(later.projectiles).toEqual(held.projectiles);
    expect(later.presentation).toEqual(held.presentation);
    const screenshotPath = "output/playwright/enemy-types-paused.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("enemy-types-paused", { path: screenshotPath, contentType: "image/png" });

    await page.getByRole("button", { name: "Resume session" }).click();
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(held.position + 0.2);
    const resumed = await snapshot(page);
    const movingShot = resumed.projectiles.find(shot => shot.id === shots[0]!.id);
    expect(movingShot).toBeDefined();
    expect(Math.hypot(movingShot!.x - shots[0]!.x, movingShot!.z - shots[0]!.z)).toBeGreaterThan(0.5);
    const playingScreenshot = "output/playwright/enemy-types-playing.png";
    await page.screenshot({ path: playingScreenshot });
    await testInfo.attach("enemy-types-and-projectiles", { path: playingScreenshot, contentType: "image/png" });

    // Keep aiming away from the ranger while it approaches. The witness remains
    // ordinary gameplay: no fixture mutates health, enemy state, or the clock.
    const away = await page.evaluate(id => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const s = api.snapshot(), target = s.enemies.find(enemy => enemy.id === id)!;
        const point = api.project([
            s.player.position.x * 2 - target.x, 0.55, s.player.position.z * 2 - target.z,
        ]);
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return point ? { x: point[0] + bounds.left, y: point[1] + bounds.top } : null;
    }, ranger.id);
    expect(away).not.toBeNull();
    await page.mouse.move(away!.x, away!.y);
    await page.waitForFunction(id => {
        const s = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return s.projectiles.some(shot => shot.shooterId === id);
    }, ranger.id, { polling: "raf", timeout: 12_000 });
    const aimed = await snapshot(page);
    expect(aimed.phase).toBe("playing");
    const shooter = aimed.enemies.find(enemy => enemy.id === ranger.id)!;
    const aimedShots = aimed.projectiles.filter(shot => shot.shooterId === ranger.id);
    expect(aimedShots).toHaveLength(1);
    const dx = aimed.player.position.x - shooter.x, dz = aimed.player.position.z - shooter.z;
    expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(7.05);
    expect(Math.hypot(dx, dz)).toBeLessThan(Math.hypot(ranger.x, ranger.z) - 1);
    const shot = aimedShots[0]!;
    expect(shot.collisionMask).toBe(1);
    expect(shot.mesh).toBeDefined();
    expect((shot.velocityX * dx + shot.velocityZ * dz)
        / (Math.hypot(shot.velocityX, shot.velocityZ) * Math.hypot(dx, dz))).toBeGreaterThan(0.999);
    expect(aimed.position % 2).toBeLessThan(0.12);
    const rangerScreenshot = "output/playwright/enemy-ranger-aimed-shot.png";
    await page.screenshot({ path: rangerScreenshot });
    await testInfo.attach("ranger-aimed-shot", { path: rangerScreenshot, contentType: "image/png" });

    await page.keyboard.press("KeyR");
    await chooseStartingUpgrade(page);
    await expect.poll(async () => (await snapshot(page)).generation).toBe(held.generation + 1);
    await expect.poll(async () => (await snapshot(page)).presentation.enemyAccentGroups).toBe(0);
    const fresh = await snapshot(page);
    expect(fresh.position).toBeLessThan(0);
    expect(fresh.enemies).toEqual([]);
    expect(fresh.projectiles).toEqual([]);
    expect(fresh.presentation).toEqual({ enemyAccentGroups: 0, enemyAccentCount: 0, projectiles: 0 });
    expect(fresh.entityCount).toBe(initial.entityCount);
    expect(fresh.bodyCount).toBe(initial.bodyCount);
    expect(errors).toEqual([]);
});
