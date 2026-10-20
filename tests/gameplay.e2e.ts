import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "./fixtures";

type Planar = { x: number; z: number };
interface Snapshot {
    phase: string;
    generation: number;
    pending: number;
    position: number;
    audioState?: string;
    player: { position: Planar; aim: Planar; target: Planar; velocity: Planar; bodyY: number };
    combat: { health: number; score: number; kills: number; time: number; enemies: number; projectiles: number; effects: number };
    entityCount: number;
    bodyCount: number;
    sounds: number;
    camera: number;
}
interface Inspection {
    snapshot(): Snapshot;
    project(point: [number, number, number]): [number, number] | null;
}
type InspectedWindow = Window & { __beatshooter?: Inspection };

const preferencesKey = "beatshooter.preferences.v1";
const snapshot = (page: Page): Promise<Snapshot> =>
    page.evaluate(() => (window as InspectedWindow).__beatshooter!.snapshot());

async function boot(page: Page): Promise<void> {
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as InspectedWindow).__beatshooter));
    await expect(page.locator(".bs-diagnostics")).toBeHidden();
}

async function playing(page: Page): Promise<void> {
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible({ timeout: 20_000 });
}

async function dojo(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await playing(page);
}

function silentWav(duration = 1.2): Buffer {
    const sampleRate = 8_000;
    const samples = Math.floor(duration * sampleRate);
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    return wav;
}

async function pointWitness(page: Page, clientX: number, clientY: number): Promise<number> {
    return page.evaluate(({ clientX, clientY }) => {
        const api = (window as InspectedWindow).__beatshooter!;
        const target = api.snapshot().player.target;
        const projected = api.project([target.x, 0.55, target.z]);
        const bounds = document.querySelector("canvas")!.getBoundingClientRect();
        return projected
            ? Math.hypot(projected[0] + bounds.left - clientX, projected[1] + bounds.top - clientY)
            : Infinity;
    }, { clientX, clientY });
}

// The default per-file ordering reduces renderer contention without skipping
// unrelated acceptance checks if one scenario fails.
test.setTimeout(90_000);

test("real movement stays planar, reset clears velocity, pointer projection survives camera follow and resize", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await dojo(page);
    await page.keyboard.down("KeyD");
    await page.keyboard.down("KeyW");
    await expect.poll(async () => (await snapshot(page)).player.position.x).toBeGreaterThan(3);
    const moving = await snapshot(page);
    expect(moving.player.position.z).toBeLessThan(-3);
    expect(Math.hypot(moving.player.velocity.x, moving.player.velocity.z)).toBeLessThanOrEqual(8.01);
    expect(moving.player.bodyY).toBeCloseTo(0.55, 4);
    await page.keyboard.up("KeyD");
    await page.keyboard.up("KeyW");
    await expect.poll(async () => {
        const { velocity } = (await snapshot(page)).player;
        return Math.hypot(velocity.x, velocity.z);
    }).toBeLessThan(0.05);

    await page.mouse.move(900, 390);
    await expect.poll(() => pointWitness(page, 900, 390)).toBeLessThan(2);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.mouse.move(720, 330);
    await expect.poll(() => pointWitness(page, 720, 330)).toBeLessThan(2);

    const generation = (await snapshot(page)).generation;
    await page.keyboard.press("KeyR");
    await chooseStartingUpgrade(page);
    await expect.poll(async () => (await snapshot(page)).generation).toBe(generation + 1);
    await playing(page);
    const reset = await snapshot(page);
    expect(Math.hypot(reset.player.position.x, reset.player.position.z)).toBeLessThan(0.02);
    expect(Math.hypot(reset.player.velocity.x, reset.player.velocity.z)).toBeLessThan(0.02);
    expect(reset.combat.health).toBe(100);
    expect(reset.combat.score).toBe(0);
    expect(reset.pending).toBe(0);
});

test("pause freezes transport and combat, resume continues, and focus loss requires another resume", async ({ page }) => {
    await boot(page);
    await dojo(page);
    await expect.poll(async () => (await snapshot(page)).combat.enemies, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    const paused = await snapshot(page);
    await page.waitForTimeout(650);
    const after = await snapshot(page);
    expect(after.position).toBe(paused.position);
    expect(after.combat).toEqual(paused.combat);
    expect(after.player.position).toEqual(paused.player.position);
    expect(after.sounds).toBe(0);
    expect(after.pending).toBe(0);

    await page.getByRole("button", { name: "Resume session" }).click();
    await playing(page);
    await expect.poll(async () => (await snapshot(page)).position).toBeGreaterThan(paused.position + 0.25);
    // Dispatch the same browser lifecycle event; this does not change game data.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await expect(page.locator('[data-value="pause-reason"]')).toContainText("focus");
    const hidden = await snapshot(page);
    await page.waitForTimeout(500);
    expect((await snapshot(page)).position).toBe(hidden.position);
    await page.getByRole("button", { name: "Resume session" }).click();
    await playing(page);
    expect((await snapshot(page)).pending).toBeLessThanOrEqual(1);
});

test("ten live retries leave no old session entities, sound effects, or duplicate command listeners", async ({ page }) => {
    await boot(page);
    const initial = await snapshot(page);
    await dojo(page);
    for (let retry = 0; retry < 10; retry++) {
        await expect.poll(async () => (await snapshot(page)).combat.enemies, { timeout: 10_000 }).toBeGreaterThan(0);
        const before = await snapshot(page);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-screen="paused"]')).toBeVisible();
        await page.getByRole("button", { name: "Restart session" }).click();
        await playing(page);
        const fresh = await snapshot(page);
        expect(fresh.generation).toBe(before.generation + 1);
        expect(fresh.combat).toEqual({
            health: 100, score: 0, kills: 0, time: 0, enemies: 0, projectiles: 0, effects: 0,
        });
        expect(fresh.entityCount).toBe(initial.entityCount);
        expect(fresh.bodyCount).toBe(initial.bodyCount);
        expect(fresh.pending).toBe(0);
        expect(fresh.sounds).toBe(0);
        expect(fresh.position).toBeLessThan(0);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.getByRole("button", { name: "Return to menu" }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    const menu = await snapshot(page);
    expect(menu.entityCount).toBe(initial.entityCount);
    expect(menu.bodyCount).toBe(initial.bodyCount);
    expect(menu.sounds).toBe(0);
    expect(menu.pending).toBe(0);
});

test("a user-selected WAV completes naturally, retries, saves its result, and requires reselection after reload", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "Import local audio" }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "browser-smoke.wav", mimeType: "audio/wav", buffer: silentWav(),
    });
    await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
    await page.locator(".bs-timing-options summary").click();
    await page.locator("#bs-local-grid").selectOption("manual");
    await page.locator("#bs-local-bpm").fill("120");
    await page.locator("#bs-local-offset").fill("0");
    await page.getByRole("button", { name: "Play this track" }).click();
    await playing(page);
    await expect(page.locator('[data-screen="results"]')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[data-value="result-title"]')).toHaveText("Track complete");
    const first = await snapshot(page);
    expect(first.combat.health).toBe(100);
    expect(first.combat.score).toBeGreaterThan(0);
    expect(first.sounds).toBe(0);
    await page.getByRole("button", { name: "Play again" }).click();
    await playing(page);
    await expect(page.locator('[data-screen="results"]')).toBeVisible({ timeout: 12_000 });
    expect((await snapshot(page)).generation).toBe(first.generation + 1);
    await page.getByRole("button", { name: "Back to sessions" }).click();
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), preferencesKey);
    expect(Object.values(stored.bestScores).some((value) => typeof value === "number" && value > 0)).toBe(true);
    await page.reload();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Import local audio" }).click();
    await page.getByRole("button", { name: "Play this track" }).click();
    await expect(page.locator('[data-value="import-error"]')).toContainText("Choose an audio file");
});

test("invalid timing and undecodable audio return actionable errors without losing the menu", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "Import local audio" }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("This is deliberately not audio."),
    });
    await expect(page.locator('.bs-analysis[data-analysis-state="error"]')).toBeVisible();
    await page.locator(".bs-timing-options summary").click();
    await page.locator("#bs-local-grid").selectOption("manual");
    await page.locator("#bs-local-bpm").fill("0");
    await page.getByRole("button", { name: "Play this track" }).click();
    await expect(page.locator('[data-value="import-error"]')).toContainText("20 and 300");
    await page.locator("#bs-local-bpm").fill("120");
    await page.getByRole("button", { name: "Play this track" }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    await expect(page.locator('[data-value="menu-error"]')).toContainText("could not be decoded", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Practice", exact: true })).toBeVisible();
    await dojo(page);
    expect((await snapshot(page)).combat.health).toBe(100);
});

test("validated settings survive reload and reset recovers corrupted persisted data", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator("#bs-master").press("Home");
    await page.locator("#bs-master").press("ArrowRight");
    await page.locator("#bs-offset").press("End");
    await page.locator("#bs-graphics").selectOption("low");
    await page.locator("#bs-reduced").check();
    await expect(page.locator("#bs-master")).toHaveValue("0.01");
    await page.reload();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.locator("#bs-master")).toHaveValue("0.01");
    await expect(page.locator("#bs-offset")).toHaveValue("250");
    await expect(page.locator("#bs-graphics")).toHaveValue("low");
    await expect(page.locator("#bs-reduced")).toBeChecked();
    await page.evaluate((key) => localStorage.setItem(key, "{corrupted"), preferencesKey);
    await page.getByRole("button", { name: "Reset settings" }).click();
    await expect(page.locator("#bs-master")).toHaveValue("0.75");
    await expect(page.locator("#bs-offset")).toHaveValue("0");
    await expect(page.locator("#bs-graphics")).toHaveValue("high");
    await expect(page.locator("#bs-reduced")).not.toBeChecked();
    await page.evaluate((key) => localStorage.setItem(key, "{corrupted-again"), preferencesKey);
    await page.reload();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.locator("#bs-master")).toHaveValue("0.75");
});

test("a naturally defeated demo reaches results and returns cleanly to track selection", async ({ page }, testInfo) => {
    await boot(page);
    await page.getByRole("button", { name: "Enter the arena" }).click();
    await playing(page);
    await expect(page.locator('[data-screen="results"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-value="result-title"]')).toHaveText("Game over");
    await expect(page.locator(".damage-layer")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("defeat-results.png") });
    const result = await snapshot(page);
    expect(result.combat.health).toBe(0);
    expect(result.combat.score).toBeGreaterThan(0);
    expect(result.pending).toBe(0);
    expect(result.sounds).toBe(0);
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    expect((await snapshot(page)).entityCount).toBe(0);
});
