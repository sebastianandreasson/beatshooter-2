import { expect, test, type Page } from "./fixtures";
import { chooseStartingUpgrade } from "./starting-upgrade";

type Point = { x: number; z: number };
interface Mesh {
    position: Point & { y: number };
    rotation: { y: number; w: number };
    scale: { x: number; y: number; z: number };
    material: number;
}
interface Ship {
    hull: Mesh; cockpit: Mesh; hullMaterial: number;
    parts: (Mesh & { entity: number })[];
    engine: {
        status: "offline" | "ready" | "waiting" | "used" | "dashing";
        material: "idle" | "ready" | "used" | "boost";
        plumeLength: number; plumeWidth: number; coreLength: number; coreWidth: number;
    };
    thrusters: {
        offset: [number, number, number];
        nozzle: Mesh & { entity: number };
        plume: Mesh & { entity: number };
        core: Mesh & { entity: number };
    }[];
}
interface Snapshot {
    phase: string; generation: number; position: number;
    player: { position: Point; aim: Point; bodyY: number; ship: Ship };
    dash: { state: string; accepted: number; active?: { endsAt: number } };
    neon: { status: string; error?: string };
    visuals: { shaderStatus: string; shaderError?: string; intensity: number; motionAllowed: boolean };
}
type InspectedWindow = Window & { __beatshooter: {
    snapshot(): Snapshot;
    project(point: [number, number, number]): [number, number] | null;
} };
const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

async function boot(page: Page) {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 45_000 });
}

async function practice(page: Page) {
    // The normal tempo control gives the short boost a longer capture window.
    await page.getByRole("spinbutton", { name: "Dojo tempo in beats per minute" }).fill("60");
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await chooseStartingUpgrade(page);
    await expect.poll(async () => (await snapshot(page)).neon.status).toBe("ready");
    await expect.poll(async () => (await snapshot(page)).visuals.shaderStatus).toBe("ready");
}

async function stateAt(page: Page, status: Ship["engine"]["status"], after = 0) {
    await page.waitForFunction(({ status, after }) => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        const phase = state.position % 1;
        return state.position > after && state.player.ship.engine.status === status
            && (status === "ready" ? phase < .035 : status !== "waiting" || (phase > .3 && phase < .6));
    }, { status, after }, { polling: "raf", timeout: 8000 });
    return snapshot(page);
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('.bs-ui[data-phase="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function shipClip(page: Page) {
    return page.evaluate(() => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const hull = api.snapshot().player.ship.hull.position;
        const point = api.project([hull.x, hull.y, hull.z])!;
        const canvas = document.querySelector("canvas")!.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(innerWidth - 256, canvas.left + point[0] - 128)),
            y: Math.max(0, Math.min(innerHeight - 256, canvas.top + point[1] - 128)),
            width: 256, height: 256,
        };
    });
}

async function captureShip(page: Page, name: string) {
    await page.screenshot({ path: `output/playwright/player-ship-${name}.png`, clip: await shipClip(page) });
}

function identities(ship: Ship) {
    return [...ship.parts.map(part => part.entity),
        ...ship.thrusters.flatMap(thruster => [thruster.plume.entity, thruster.core.entity])];
}

function assertShip(state: Snapshot) {
    const { ship, aim } = state.player;
    expect(ship.parts).toHaveLength(7);
    expect(ship.thrusters).toHaveLength(2);
    expect(new Set(identities(ship)).size).toBe(11);
    expect(state.player.bodyY).toBeCloseTo(.55, 4);
    const { y, w } = ship.hull.rotation;
    const forward = { x: -2 * y * w, z: 2 * y * y - 1 };
    expect(forward.x * aim.x + forward.z * aim.z).toBeGreaterThan(.995);
    for (const part of ship.parts) {
        expect(part.rotation.y).toBeCloseTo(y, 4);
        expect(part.rotation.w).toBeCloseTo(w, 4);
        expect(Math.hypot(part.position.x - ship.hull.position.x,
            part.position.z - ship.hull.position.z)).toBeLessThan(2);
        expect(part.scale.x).toBeGreaterThan(0);
        expect(part.scale.y).toBeGreaterThan(0);
        expect(part.scale.z).toBeGreaterThan(0);
    }
    for (const thruster of ship.thrusters) {
        const [x, height, z] = thruster.offset;
        const expected = {
            x: ship.hull.position.x + (1 - 2 * y * y) * x + 2 * y * w * z,
            y: ship.hull.position.y + height,
            z: ship.hull.position.z - 2 * y * w * x + (1 - 2 * y * y) * z,
        };
        for (const mesh of [thruster.plume, thruster.core]) {
            expect(mesh.position.x).toBeCloseTo(expected.x, 4);
            expect(mesh.position.y).toBeCloseTo(expected.y, 4);
            expect(mesh.position.z).toBeCloseTo(expected.z, 4);
            expect(mesh.rotation.y).toBeCloseTo(y, 4);
            expect(mesh.rotation.w).toBeCloseTo(w, 4);
        }
        expect(thruster.plume.scale.z).toBeCloseTo(ship.engine.plumeLength, 4);
        expect(thruster.plume.scale.x).toBeCloseTo(ship.engine.plumeWidth, 4);
        expect(thruster.core.scale.z).toBeCloseTo(ship.engine.coreLength, 4);
        expect(thruster.core.scale.x).toBeCloseTo(ship.engine.coreWidth, 4);
    }
}

function watchErrors(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error" && /webgpu|gpuvalidation|shader|validation error/i.test(message.text())) {
            errors.push(message.text());
        }
    });
    return errors;
}

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
test.setTimeout(70_000);

test("the triangular ship follows real controls and shows beat-ready, boost, used, pause and reset states", async ({ page }) => {
    const errors = watchErrors(page);
    await boot(page);
    await practice(page);
    const target = await page.evaluate(() => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const player = api.snapshot().player.position;
        const pixel = api.project([player.x + 10, .55, player.z - 6])!;
        const canvas = document.querySelector("canvas")!.getBoundingClientRect();
        return { x: canvas.left + pixel[0], y: canvas.top + pixel[1] };
    });
    await page.mouse.move(target.x, target.y);
    const waiting = await stateAt(page, "waiting");
    assertShip(waiting);
    expect(waiting.player.ship.engine.material).toBe("idle");
    expect(waiting.player.ship.hull.material).toBe(waiting.player.ship.hullMaterial);
    const pool = identities(waiting.player.ship);
    await page.screenshot({ path: "output/playwright/player-ship-arena.png" });
    await captureShip(page, "waiting");

    await page.keyboard.down("KeyD");
    await page.waitForTimeout(180);
    await page.keyboard.up("KeyD");
    await expect.poll(async () => (await snapshot(page)).player.position.x).toBeGreaterThan(waiting.player.position.x + .5);
    const ready = await stateAt(page, "ready", waiting.position + .5);
    assertShip(ready);
    expect(ready.player.ship.engine.material).toBe("ready");
    expect(ready.player.ship.engine.plumeLength).toBeGreaterThan(waiting.player.ship.engine.plumeLength);
    expect(ready.player.ship.thrusters[0]!.nozzle.material).not.toBe(waiting.player.ship.thrusters[0]!.nozzle.material);
    await captureShip(page, "ready");

    // Capture a real short boost; if a slow screenshot crosses its endpoint,
    // try the next legal bar rather than changing the simulation clock.
    let boost: Snapshot | undefined;
    for (let attempt = 0; attempt < 3 && !boost; attempt++) {
        const before = await snapshot(page);
        const clip = await shipClip(page);
        await stateAt(page, "ready", before.position + .4);
        await page.keyboard.down("KeyD");
        await page.keyboard.press("Space");
        await page.keyboard.up("KeyD");
        await page.waitForFunction(() =>
            (window as unknown as InspectedWindow).__beatshooter.snapshot().player.ship.engine.status === "dashing",
        undefined, { polling: "raf", timeout: 1000 });
        const active = await snapshot(page);
        await page.screenshot({ path: "output/playwright/player-ship-boost.png", clip });
        if ((await snapshot(page)).player.ship.engine.status === "dashing") boost = active;
    }
    expect(boost, "a screenshot must capture the actual short dash boost").toBeDefined();
    assertShip(boost!);
    expect(boost!.player.ship.engine.material).toBe("boost");
    expect(boost!.player.ship.engine.plumeLength).toBeGreaterThan(ready.player.ship.engine.plumeLength);
    expect(boost!.dash.accepted).toBeGreaterThan(0);
    const used = await stateAt(page, "used", boost!.position);
    assertShip(used);
    expect(used.player.ship.engine.material).toBe("used");
    expect(used.player.ship.engine.plumeLength).toBeLessThan(ready.player.ship.engine.plumeLength);
    await captureShip(page, "used");

    await pause(page);
    const held = await snapshot(page);
    await page.waitForTimeout(250);
    const frozen = await snapshot(page);
    expect(frozen.position).toBe(held.position);
    expect(frozen.player.ship).toEqual(held.player.ship);
    expect(frozen.player.position).toEqual(held.player.position);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    const renewed = await stateAt(page, "ready", held.position);
    expect(renewed.player.ship.engine.material).toBe("ready");
    expect(identities(renewed.player.ship)).toEqual(pool);
    await pause(page);
    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="starting"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).player.ship.engine?.status).toBe("offline");
    const reset = await snapshot(page);
    expect(reset.generation).toBeGreaterThan(held.generation);
    expect(reset.dash.accepted).toBe(0);
    expect(reset.player.ship.engine.status).toBe("offline");
    expect(reset.player.ship.engine.plumeLength).toBe(0);
    expect(reset.player.ship.engine.coreLength).toBe(0);
    expect(reset.player.ship.hull.material).toBe(waiting.player.ship.hullMaterial);
    expect(reset.player.ship.cockpit.material).toBe(waiting.player.ship.cockpit.material);
    expect(identities(reset.player.ship)).toEqual(pool);
    await chooseStartingUpgrade(page);
    assertShip(await stateAt(page, "waiting"));
    expect((await snapshot(page)).neon.error).toBeUndefined();
    expect((await snapshot(page)).visuals.shaderError).toBeUndefined();
    expect(errors).toEqual([]);
});

test("Off, reduced flashes and reduced motion preserve a readable ship readiness cue", async ({ page }) => {
    const errors = watchErrors(page);
    await boot(page);
    await practice(page);
    for (const mode of ["off", "reduced-flashes", "reduced-motion"] as const) {
        await pause(page);
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("combobox", { name: "Visual effects", exact: true })
            .selectOption(mode === "off" ? "off" : "standard");
        await page.locator("#bs-reduced").setChecked(mode === "reduced-flashes");
        await page.emulateMedia({ reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference" });
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.getByRole("button", { name: "Resume session", exact: true }).click();
        const waiting = await stateAt(page, "waiting");
        const ready = await stateAt(page, "ready", waiting.position);
        assertShip(ready);
        expect(ready.player.ship.engine.material).toBe("ready");
        expect(ready.player.ship.engine.coreLength).toBe(0);
        expect(ready.player.ship.engine.plumeLength).toBe(0);
        expect(ready.player.ship.thrusters[0]!.nozzle.material).not.toBe(waiting.player.ship.thrusters[0]!.nozzle.material);
        if (mode === "off") expect(ready.visuals.intensity).toBe(0);
        if (mode === "reduced-motion") expect(ready.visuals.motionAllowed).toBe(false);
        await captureShip(page, mode);
    }
    expect(errors).toEqual([]);
});
