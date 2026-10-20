import { chooseStartingUpgrade } from "./starting-upgrade";
import { expect, test, type Page } from "playwright/test";
import { ANALYZER_VERSION, type BeatAnalysis } from "../src/analysis/types";
import { SECTION_ANALYZER_VERSION } from "../src/analysis/sections";
import { shockwaveHeight } from "../src/shockwave/surface";

interface SectionSnapshot {
    phase: string;
    generation: number;
    position: number;
    bodyCount: number;
    analysis?: { state: string };
    chart: { beatCount: number; downbeatCount: number };
    enemies: { id: number; body?: { position: { x: number; y: number; z: number } } }[];
    visuals: { shaderStatus: string };
    neon: {
        status: "pending" | "ready" | "fallback";
        frame: { enabled: boolean; bloom: number; chromatic: number };
    };
    starfield: {
        distance: number;
        speed: number;
        boost: number;
        motionAllowed: boolean;
        entityCount: number;
    };
    player: {
        position: { x: number; z: number };
        target: { x: number; z: number };
        velocity: { x: number; z: number };
        bodyY: number;
    };
    sectionEffects: {
        active: boolean;
        sectionIndex: number;
        label?: string;
        startTime: number;
        endTime: number;
        progress: number;
        waveProgress: number;
        anticipation: number;
        anticipating: boolean;
        impact: number;
        strength: number;
        palette: unknown;
        motionAllowed: boolean;
        surface: {
            peakLift: number;
            vertexCount: number;
            affectedCount: number;
            samples: { x: number; z: number; height: number }[];
        };
        shockwave: {
            radius: number;
            active: boolean;
            from: unknown;
            to: unknown;
        };
        map: {
            position: { x: number; y: number; z: number };
            rotation: { x: number; y: number; z: number; w: number };
        };
        camera: {
            position: { x: number; y: number; z: number };
            rotation: { x: number; y: number; z: number; w: number };
            size: number;
            clearColor: number;
        };
    };
}

interface MotionSample {
    position: number;
    progress: number;
    waveProgress: number;
    anticipation: number;
    impact: number;
    radius: number;
    shockwaveActive: boolean;
    velocityX: number;
    cameraRotation: SectionSnapshot["sectionEffects"]["camera"]["rotation"];
    cameraSize: number;
    map: SectionSnapshot["sectionEffects"]["map"];
    starfield: SectionSnapshot["starfield"];
    healthbarAnchors: { x: number; z: number; lift: number; projectionError: number }[];
    strength: number;
    screenVelocity: [number, number] | null;
    speed: number;
}

type InspectedWindow = Window & {
    __beatshooter: {
        snapshot(): SectionSnapshot;
        project(point: [number, number, number]): [number, number] | null;
        analysis(): BeatAnalysis | null;
    };
    __sectionMotion?: MotionSample[];
};

const snapshot = (page: Page) => page.evaluate(() =>
    (window as unknown as InspectedWindow).__beatshooter.snapshot());

function wav(duration: number): Buffer {
    const sampleRate = 8_000, samples = duration * sampleRate;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(sampleRate, 24);
    bytes.writeUInt32LE(sampleRate * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

async function boot(page: Page, mode: "standard" | "off" | "reduced" = "standard") {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
    // Replace only inference at the existing worker/network seam. Decoding,
    // PCM transfer, chart validation, section validation, selection, and real
    // Web Audio playback all use the shipped application. No game state is set.
    await page.route(/\/(?:assets\/worker-[^/]+\.js|src\/analysis\/worker\.ts)(?:\?.*)?$/, route =>
        route.fulfill({
            contentType: "application/javascript",
            // A module worker in this isolated page must retain the same
            // embedder policy as the production worker response.
            headers: { "Cross-Origin-Embedder-Policy": "require-corp" },
            body: `
                self.onmessage = ({ data }) => {
                    if (data.type !== "analyze") return;
                    const { duration, pcm } = data;
                    if (!(pcm instanceof Float32Array) || duration !== 12
                        || Math.abs(pcm.length - duration * 22050) > 1) {
                        self.postMessage({ type: "error", message: "Invalid decoded section fixture." });
                        return;
                    }
                    const beats = Array.from({ length: duration * 2 }, (_, index) => index * .5);
                    self.postMessage({ type: "result", result: {
                        schemaVersion: 1, analyzerVersion: ${JSON.stringify(ANALYZER_VERSION)},
                        duration, beats, downbeats: beats.filter((_, index) => index % 4 === 0),
                        elapsedMs: 1, backend: "wasm",
                        structure: {
                            version: 1, analyzerVersion: ${JSON.stringify(SECTION_ANALYZER_VERSION)},
                            duration, elapsedMs: 1, backend: "wasm",
                            sections: [
                                { start: 0, end: 2, label: "intro" },
                                { start: 2, end: 7, label: "chorus" },
                                { start: 7, end: duration, label: "chorus" },
                            ],
                        },
                    } });
                };
            `,
        }));
    await page.goto("/?test=1");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as unknown as InspectedWindow).__beatshooter));
    if (mode === "off") {
        await page.getByRole("button", { name: "Open settings" }).click();
        await page.getByRole("combobox", { name: "Visual effects", exact: true }).selectOption("off");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
    }
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "section-transition-fixture.wav", mimeType: "audio/wav", buffer: wav(12),
    });
    await expect.poll(async () => (await snapshot(page)).analysis?.state).toBe("ready");
    await expect(page.locator(".bs-section-preview .bs-player-band")).toHaveCount(3);
    await page.locator('[data-action="start-local"]').click();
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > 0.1 && state.position < 1.5;
    }, undefined, { polling: "raf", timeout: 10_000 });
    return snapshot(page);
}

async function atProgress(page: Page, progress: number, sectionIndex = 1) {
    const value = await page.waitForFunction(({ progress, sectionIndex }) => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.sectionEffects.sectionIndex === sectionIndex
            && state.sectionEffects.progress >= progress
            && state.sectionEffects.progress < progress + 0.12 ? state : false;
    }, { progress, sectionIndex }, { polling: "raf", timeout: 8_000 });
    return await value.jsonValue() as SectionSnapshot;
}

async function atAnticipation(page: Page, anticipation: number, sectionIndex = 0) {
    const value = await page.waitForFunction(({ anticipation, sectionIndex }) => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.sectionEffects.sectionIndex === sectionIndex && state.sectionEffects.anticipating
            && state.sectionEffects.anticipation >= anticipation
            && state.sectionEffects.anticipation < anticipation + 0.15 ? state : false;
    }, { anticipation, sectionIndex }, { polling: "raf", timeout: 8_000 });
    return await value.jsonValue() as SectionSnapshot;
}

async function pause(page: Page) {
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-screen="paused"]')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function pointerError(page: Page, x: number, y: number) {
    return page.evaluate(({ x, y }) => {
        const api = (window as unknown as InspectedWindow).__beatshooter;
        const { target } = api.snapshot().player;
        const projected = api.project([target.x, 0.55, target.z]);
        const rect = document.querySelector("canvas")!.getBoundingClientRect();
        return projected ? Math.hypot(projected[0] + rect.left - x, projected[1] + rect.top - y) : Infinity;
    }, { x, y });
}

async function recordMotion(page: Page) {
    await page.evaluate(() => {
        const target = window as unknown as InspectedWindow;
        target.__sectionMotion = [];
        const sample = () => {
            const state = target.__beatshooter.snapshot();
            if (!["playing", "paused"].includes(state.phase)
                || state.sectionEffects.sectionIndex > 1
                || (state.sectionEffects.sectionIndex === 1 && state.position >= state.sectionEffects.endTime)) return;
            const player = state.player.position, velocity = state.player.velocity;
            const from = target.__beatshooter.project([player.x, 0.55, player.z]);
            const to = target.__beatshooter.project([player.x + velocity.x * 0.1, 0.55, player.z + velocity.z * 0.1]);
            const canvas = document.querySelector("canvas")!.getBoundingClientRect();
            const healthbarAnchors = state.phase !== "playing" ? []
                : [...document.querySelectorAll<HTMLElement>(".enemy-healthbar")].flatMap(element => {
                    const body = state.enemies.find(enemy => enemy.id === Number(element.dataset.enemyId))?.body?.position;
                    if (!body || element.hidden) return [];
                    const lift = Number(element.dataset.surfaceLift);
                    const pixel = target.__beatshooter.project([body.x, 1.8 + lift, body.z]);
                    if (!pixel) return [];
                    const rect = element.getBoundingClientRect();
                    return [{
                        x: body.x, z: body.z, lift,
                        projectionError: Math.hypot(rect.x + rect.width / 2 - canvas.left - pixel[0],
                            rect.y + rect.height / 2 - canvas.top - pixel[1]),
                    }];
                });
            target.__sectionMotion!.push({
                position: state.position, progress: state.sectionEffects.progress,
                waveProgress: state.sectionEffects.waveProgress,
                anticipation: state.sectionEffects.anticipation, impact: state.sectionEffects.impact,
                radius: state.sectionEffects.shockwave.radius,
                shockwaveActive: state.sectionEffects.shockwave.active,
                velocityX: velocity.x,
                cameraRotation: state.sectionEffects.camera.rotation,
                cameraSize: state.sectionEffects.camera.size,
                map: state.sectionEffects.map,
                starfield: state.starfield,
                healthbarAnchors, strength: state.sectionEffects.strength,
                screenVelocity: from && to ? [to[0] - from[0], to[1] - from[1]] : null,
                speed: Math.hypot(velocity.x, velocity.z),
            });
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
}

function expectCameraZoom(state: SectionSnapshot, gain = 0.05) {
    expect(state.sectionEffects.camera.size).toBeCloseTo(17 / (1 + gain * state.sectionEffects.impact), 5);
}

function expectFlatSurface(state: SectionSnapshot) {
    expect(state.sectionEffects.surface.peakLift).toBe(0);
    expect(state.sectionEffects.surface.samples.every(sample => sample.height === 0)).toBe(true);
}

test.setTimeout(60_000);

test("a section charges and eases into a shockwave while controls and replay stay stable", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const baseline = await boot(page);
    expect(baseline.visuals.shaderStatus).toBe("ready");
    expect(baseline.neon.status).toBe("ready");
    expect(baseline.neon.frame.chromatic).toBe(0);
    expect(baseline.chart.beatCount).toBe(24);
    expect(baseline.chart.downbeatCount).toBe(6);
    expect(baseline.sectionEffects.sectionIndex).toBe(0);
    expect(baseline.sectionEffects.active).toBe(false);
    expect(baseline.sectionEffects.shockwave.active).toBe(false);
    expect(baseline.sectionEffects.shockwave.radius).toBe(0);
    expect(baseline.sectionEffects.anticipating).toBe(false);
    expect(baseline.sectionEffects.anticipation).toBe(0);
    expect(baseline.sectionEffects.impact).toBe(0);
    expect(baseline.sectionEffects.camera.size).toBe(17);
    expect(baseline.sectionEffects.surface.vertexCount).toBeGreaterThan(1000);
    expectFlatSurface(baseline);
    expect(baseline.starfield.motionAllowed).toBe(true);
    expect(baseline.starfield.distance).toBeGreaterThan(0);
    expect(baseline.starfield.speed).toBe(5);
    expect(baseline.starfield.boost).toBe(0);
    expect(baseline.starfield.entityCount).toBe(960);
    const driftingHandle = await page.waitForFunction(position => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > position + 0.15 && state.position < 1.5 ? state : false;
    }, baseline.position, { polling: "raf", timeout: 3_000 });
    const drifting = await driftingHandle.jsonValue() as SectionSnapshot;
    expect(drifting.starfield.distance).toBeGreaterThan(baseline.starfield.distance);
    expect(drifting.starfield.speed).toBe(5);
    expect(drifting.starfield.entityCount).toBe(baseline.starfield.entityCount);
    const baselinePath = "output/playwright/section-starfield-drift.png";
    await page.screenshot({ path: baselinePath });
    await testInfo.attach("section-starfield-drift", { path: baselinePath, contentType: "image/png" });

    // Sample the live camera, world geometry and projections before the charge
    // begins, through the boundary, and until the outward wave has completed.
    await recordMotion(page);
    const charge = await atAnticipation(page, 0.25);
    await pause(page);
    const heldCharge = await snapshot(page);
    expect(charge.position).toBeGreaterThanOrEqual(1.5);
    expect(charge.position).toBeLessThan(2);
    expect(charge.sectionEffects.sectionIndex).toBe(0);
    expect(charge.sectionEffects.label).toBe("intro");
    expect(charge.sectionEffects.anticipating).toBe(true);
    expect(charge.sectionEffects.anticipation).toBeGreaterThan(0);
    const chargeProgress = (charge.position - 1.5) / 0.5;
    expect(charge.sectionEffects.anticipation).toBeCloseTo(
        chargeProgress ** 2 * (3 - 2 * chargeProgress), 5);
    expect(charge.sectionEffects.impact).toBe(charge.sectionEffects.anticipation);
    expect(charge.sectionEffects.active).toBe(false);
    expect(charge.sectionEffects.shockwave.active).toBe(false);
    expect(charge.sectionEffects.shockwave.radius).toBe(0);
    expect(charge.sectionEffects.palette).toEqual(baseline.sectionEffects.palette);
    expect(charge.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expectCameraZoom(charge);
    expect(charge.sectionEffects.camera.size).toBeLessThan(17);
    expect(charge.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expectFlatSurface(charge);
    expect(charge.starfield.speed).toBe(5);
    expect(charge.starfield.boost).toBe(0);
    expect(heldCharge.sectionEffects.anticipating).toBe(true);
    expectCameraZoom(heldCharge);
    await expect(page.locator(".bs-run-progress .bs-player-section")).toHaveText("Intro");
    await page.waitForTimeout(180);
    const frozenCharge = await snapshot(page);
    expect(frozenCharge.position).toBe(heldCharge.position);
    expect(frozenCharge.sectionEffects).toEqual(heldCharge.sectionEffects);
    expect(frozenCharge.starfield).toEqual(heldCharge.starfield);
    expect(frozenCharge.neon.frame).toEqual(heldCharge.neon.frame);
    await page.mouse.move(830, 330);
    await expect.poll(() => pointerError(page, 830, 330)).toBeLessThan(2);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await page.keyboard.down("KeyD");
    const beginning = await atProgress(page, 0.08);
    await page.keyboard.up("KeyD");
    expect(beginning.visuals.shaderStatus).toBe("ready");
    expect(beginning.neon.status).toBe("ready");
    expect(beginning.neon.frame.chromatic).toBeGreaterThan(0);
    expect(beginning.sectionEffects.active).toBe(true);
    expect(beginning.sectionEffects.label).toBe("chorus");
    expect(beginning.sectionEffects.startTime).toBe(2);
    expect(beginning.sectionEffects.endTime - beginning.sectionEffects.startTime).toBeCloseTo(2 / 1.3, 6);
    expect(beginning.sectionEffects.progress).toBeCloseTo(
        (beginning.position - 2) / (beginning.sectionEffects.endTime - 2), 5);
    expect(beginning.sectionEffects.waveProgress).toBeCloseTo(
        beginning.sectionEffects.progress ** 2 * (3 - 2 * beginning.sectionEffects.progress), 5);
    expect(beginning.sectionEffects.waveProgress).toBeLessThan(beginning.sectionEffects.progress);
    expect(beginning.sectionEffects.anticipating).toBe(false);
    expect(beginning.sectionEffects.anticipation).toBe(0);
    expect(beginning.sectionEffects.impact).toBeGreaterThan(0);
    const releaseProgress = (beginning.position - 2) / 0.5;
    expect(beginning.sectionEffects.impact).toBeCloseTo(
        1 - releaseProgress ** 2 * (3 - 2 * releaseProgress), 5);
    expect(beginning.sectionEffects.shockwave.active).toBe(true);
    expect(beginning.sectionEffects.shockwave.radius).toBeCloseTo(beginning.sectionEffects.waveProgress * 30, 5);
    expect(beginning.sectionEffects.shockwave.from).toEqual(baseline.sectionEffects.palette);
    expect(beginning.sectionEffects.shockwave.to).not.toEqual(beginning.sectionEffects.shockwave.from);
    expect(beginning.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expectCameraZoom(beginning);
    expect(beginning.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(beginning.sectionEffects.palette).not.toEqual(baseline.sectionEffects.palette);
    expect(beginning.starfield.boost).toBeGreaterThan(0);
    expect(beginning.starfield.speed).toBeGreaterThan(5);
    expect(beginning.starfield.distance).toBeGreaterThan(drifting.starfield.distance);
    expect(beginning.starfield.entityCount).toBe(baseline.starfield.entityCount);
    await expect(page.locator(".bs-run-progress .bs-player-section")).toHaveText("Chorus");

    const middle = await atProgress(page, 0.48);
    expect(middle.sectionEffects.shockwave.active).toBe(true);
    expect(middle.neon.frame.chromatic).toBeGreaterThan(0);
    expect(middle.sectionEffects.shockwave.radius).toBeGreaterThan(beginning.sectionEffects.shockwave.radius);
    expect(middle.sectionEffects.shockwave.radius).toBeCloseTo(middle.sectionEffects.waveProgress * 30, 5);
    expect(middle.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(middle.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(middle.sectionEffects.camera.size).toBe(17);
    expect(middle.sectionEffects.impact).toBe(0);
    expect(middle.player.bodyY).toBeCloseTo(0.55, 4);
    const surface = middle.sectionEffects.surface;
    expect(surface.vertexCount).toBeGreaterThan(1000);
    expect(surface.affectedCount).toBeGreaterThan(0);
    expect(surface.peakLift).toBeGreaterThan(0.7);
    const radius = middle.sectionEffects.shockwave.radius;
    const heightAt = (x: number) => {
        const sample = surface.samples.find(sample => Math.abs(sample.x - x) < 1e-6 && sample.z === 0);
        expect(sample).toBeDefined();
        return sample!.height;
    };
    expect(heightAt(radius)).toBeCloseTo(surface.peakLift, 6);
    expect(heightAt(radius + 4)).toBe(0);
    expect(heightAt(Math.max(0, radius - 4))).toBe(0);
    expect(heightAt(0)).toBe(0);
    expect(middle.starfield.speed).toBeGreaterThan(100);
    expect(middle.starfield.distance).toBeGreaterThan(beginning.starfield.distance);
    expect(middle.starfield.entityCount).toBe(baseline.starfield.entityCount);
    const motion = await page.evaluate(() => (window as unknown as InspectedWindow).__sectionMotion!);
    const moving = motion.filter(frame =>
        frame.impact > 0.05 && frame.speed > 2 && frame.screenVelocity);
    expect(moving.length).toBeGreaterThan(2);
    expect(moving.every(frame => frame.screenVelocity![0] > 0)).toBe(true);
    expect(moving.every(frame => frame.velocityX > 0)).toBe(true);
    const screenshotPath = "output/playwright/section-shockwave-bulge.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("section-shockwave-bulge", { path: screenshotPath, contentType: "image/png" });
    await pause(page);
    const held = await snapshot(page);
    expect(held.sectionEffects.active).toBe(true);
    await page.waitForTimeout(250);
    const frozen = await snapshot(page);
    expect(frozen.position).toBe(held.position);
    expect(frozen.sectionEffects).toEqual(held.sectionEffects);
    expect(frozen.player.position).toEqual(held.player.position);
    expect(frozen.starfield).toEqual(held.starfield);
    expect(frozen.neon.frame).toEqual(held.neon.frame);

    await page.mouse.move(830, 330);
    await expect.poll(() => pointerError(page, 830, 330)).toBeLessThan(2);
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position > state.sectionEffects.endTime + 0.1
            && state.position < 6 && !state.sectionEffects.active;
    }, undefined, { polling: "raf", timeout: 5_000 });
    const settled = await snapshot(page);
    const allMotion = await page.evaluate(() => (window as unknown as InspectedWindow).__sectionMotion!);
    expect(allMotion.some(frame => frame.shockwaveActive && frame.progress > 0.9)).toBe(true);
    expect(allMotion.some(frame => frame.position < 2 && frame.anticipation > 0)).toBe(true);
    expect(Math.max(...allMotion.map(frame => frame.impact))).toBeGreaterThan(0.97);
    expect(allMotion.some(frame => frame.position >= 2.5 && frame.impact === 0)).toBe(true);
    const peakSpeed = Math.max(...allMotion.map(frame => frame.starfield.speed));
    expect(Math.abs(peakSpeed / baseline.starfield.speed - 25)).toBeLessThan(0.5);
    const liftedBars = allMotion.flatMap(frame => frame.healthbarAnchors
        .filter(bar => bar.lift > 0.05).map(bar => ({
            ...bar, waveProgress: frame.waveProgress, strength: frame.strength,
        })));
    expect(liftedBars.length).toBeGreaterThan(0);
    for (const bar of liftedBars) {
        expect(bar.lift).toBeCloseTo(shockwaveHeight(bar.waveProgress, bar.strength, bar.x, bar.z), 5);
        expect(bar.projectionError).toBeLessThan(2);
    }
    for (const frame of allMotion) {
        expect(frame.cameraRotation).toEqual(baseline.sectionEffects.camera.rotation);
        expect(frame.cameraSize).toBeCloseTo(17 / (1 + 0.05 * frame.impact), 5);
        if (frame.shockwaveActive) {
            expect(frame.waveProgress).toBeCloseTo(frame.progress ** 2 * (3 - 2 * frame.progress), 5);
            expect(frame.radius).toBeCloseTo(frame.waveProgress * 30, 5);
        }
        expect(frame.map).toEqual(baseline.sectionEffects.map);
        expect(frame.starfield.entityCount).toBe(baseline.starfield.entityCount);
    }
    for (let index = 1; index < allMotion.length; index++) {
        expect(allMotion[index]!.radius).toBeGreaterThanOrEqual(allMotion[index - 1]!.radius);
        expect(allMotion[index]!.starfield.distance).toBeGreaterThanOrEqual(allMotion[index - 1]!.starfield.distance);
    }
    expect(settled.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(settled.sectionEffects.camera.size).toBe(17);
    expect(settled.sectionEffects.impact).toBe(0);
    expect(settled.sectionEffects.anticipation).toBe(0);
    expect(settled.sectionEffects.shockwave.active).toBe(false);
    expect(settled.neon.frame.chromatic).toBe(0);
    expect(settled.sectionEffects.shockwave.radius).toBe(0);
    expectFlatSurface(settled);
    expect(settled.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(settled.sectionEffects.palette).toEqual(beginning.sectionEffects.shockwave.to);
    expect(settled.sectionEffects.camera.clearColor).not.toBe(baseline.sectionEffects.camera.clearColor);
    expect(settled.starfield.distance).toBeGreaterThan(held.starfield.distance);
    expect(settled.starfield.speed).toBe(5);
    expect(settled.starfield.boost).toBe(0);
    expect(settled.starfield.entityCount).toBe(baseline.starfield.entityCount);

    // Adjacent sections may share their analysis label. The new boundary must
    // still carry a distinct palette, and retain it once its wave has passed.
    const repeatedCharge = await atAnticipation(page, 0.25, 1);
    expect(repeatedCharge.sectionEffects.label).toBe("chorus");
    expect(repeatedCharge.sectionEffects.palette).toEqual(settled.sectionEffects.palette);
    const repeated = await atProgress(page, 0.08, 2);
    expect(repeated.sectionEffects.label).toBe("chorus");
    expect(repeated.sectionEffects.active).toBe(true);
    expect(repeated.sectionEffects.startTime).toBe(7);
    expect(repeated.sectionEffects.endTime - repeated.sectionEffects.startTime).toBeCloseTo(2 / 1.3, 6);
    expect(repeated.sectionEffects.shockwave.active).toBe(true);
    expect(repeated.sectionEffects.shockwave.from).toEqual(settled.sectionEffects.palette);
    expect(repeated.sectionEffects.shockwave.to).not.toEqual(repeated.sectionEffects.shockwave.from);
    expectCameraZoom(repeated);
    await expect(page.locator(".bs-run-progress .bs-player-section")).toHaveText("Chorus");
    const repeatedSettledHandle = await page.waitForFunction(() => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.sectionEffects.sectionIndex === 2 && !state.sectionEffects.active
            && state.position >= state.sectionEffects.endTime + 0.1 ? state : false;
    }, undefined, { polling: "raf", timeout: 4_000 });
    const repeatedSettled = await repeatedSettledHandle.jsonValue() as SectionSnapshot;
    expect(repeatedSettled.sectionEffects.palette).toEqual(repeated.sectionEffects.shockwave.to);
    expect(repeatedSettled.sectionEffects.palette).not.toEqual(settled.sectionEffects.palette);
    expect(repeatedSettled.sectionEffects.camera.clearColor).not.toBe(settled.sectionEffects.camera.clearColor);
    expect(repeatedSettled.sectionEffects.camera.size).toBe(17);
    expect(repeatedSettled.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    const persistentHandle = await page.waitForFunction(position => {
        const state = (window as unknown as InspectedWindow).__beatshooter.snapshot();
        return state.position >= position + 0.2 ? state : false;
    }, repeatedSettled.position, { polling: "raf", timeout: 2_000 });
    const persistent = await persistentHandle.jsonValue() as SectionSnapshot;
    expect(persistent.sectionEffects.sectionIndex).toBe(2);
    expect(persistent.sectionEffects.label).toBe("chorus");
    expect(persistent.sectionEffects.palette).toEqual(repeatedSettled.sectionEffects.palette);
    expect(persistent.sectionEffects.shockwave.active).toBe(false);
    expectFlatSurface(persistent);

    await pause(page);
    await page.getByRole("button", { name: "Restart session", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).generation).toBe(baseline.generation + 1);
    const restarted = await snapshot(page);
    expect(restarted.position).toBeLessThanOrEqual(0);
    expect(restarted.sectionEffects.active).toBe(false);
    expect(restarted.neon.frame.chromatic).toBe(0);
    expectFlatSurface(restarted);
    expect(restarted.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(restarted.sectionEffects.camera.size).toBe(17);
    expect(restarted.sectionEffects.impact).toBe(0);
    expect(restarted.sectionEffects.anticipation).toBe(0);
    expect(restarted.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(restarted.starfield.boost).toBe(0);
    expect(restarted.starfield.entityCount).toBe(baseline.starfield.entityCount);
    await chooseStartingUpgrade(page);
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await atProgress(page, 0.2);
    await pause(page);
    await page.getByRole("button", { name: "Return to menu", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).sectionEffects.active).toBe(false);
    const menu = await snapshot(page);
    expect(menu.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
    expect(menu.sectionEffects.camera.size).toBe(17);
    expect(menu.sectionEffects.impact).toBe(0);
    expect(menu.sectionEffects.anticipation).toBe(0);
    expect(menu.sectionEffects.camera.clearColor).toBe(0x090f15);
    expectFlatSurface(menu);
    expect(menu.sectionEffects.map).toEqual(baseline.sectionEffects.map);
    expect(menu.bodyCount).toBe(baseline.bodyCount);
    expect(menu.starfield.entityCount).toBe(baseline.starfield.entityCount);
    expect(errors).toEqual([]);
});

for (const mode of ["off", "reduced"] as const) {
    test(`${mode} motion keeps section palette changes without a travelling shockwave`, async ({ page }, testInfo) => {
        const baseline = await boot(page, mode);
        expect(baseline.starfield.motionAllowed).toBe(false);
        expect(baseline.starfield.speed).toBe(0);
        expect(baseline.starfield.boost).toBe(0);
        expect(baseline.starfield.entityCount).toBe(960);
        expectFlatSurface(baseline);
        const charge = await atAnticipation(page, 0.25);
        expect(charge.sectionEffects.sectionIndex).toBe(0);
        expect(charge.sectionEffects.label).toBe("intro");
        expect(charge.sectionEffects.palette).toEqual(baseline.sectionEffects.palette);
        expect(charge.sectionEffects.motionAllowed).toBe(false);
        expect(charge.sectionEffects.shockwave.active).toBe(false);
        expect(charge.sectionEffects.shockwave.radius).toBe(0);
        expect(charge.sectionEffects.camera.size).toBe(17);
        expect(charge.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
        expect(charge.sectionEffects.map).toEqual(baseline.sectionEffects.map);
        expect(charge.starfield).toEqual(baseline.starfield);
        expect(charge.neon.frame.chromatic).toBe(0);
        expectFlatSurface(charge);
        const middle = await atProgress(page, 0.5);
        expect(middle.sectionEffects.label).toBe("chorus");
        expect(middle.sectionEffects.motionAllowed).toBe(false);
        expect(middle.sectionEffects.shockwave.active).toBe(false);
        expect(middle.neon.frame.chromatic).toBe(0);
        expect(middle.sectionEffects.shockwave.radius).toBe(0);
        expectFlatSurface(middle);
        expect(middle.sectionEffects.map).toEqual(baseline.sectionEffects.map);
        expect(middle.sectionEffects.camera.rotation).toEqual(baseline.sectionEffects.camera.rotation);
        expect(middle.sectionEffects.camera.size).toBe(17);
        expect(middle.sectionEffects.camera.clearColor).not.toBe(baseline.sectionEffects.camera.clearColor);
        expect(middle.sectionEffects.palette).not.toEqual(baseline.sectionEffects.palette);
        expect(middle.starfield).toEqual(baseline.starfield);
        const screenshotPath = `output/playwright/section-map-${mode}.png`;
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`section-map-${mode}`, { path: screenshotPath, contentType: "image/png" });
        await pause(page);
        const held = await snapshot(page);
        await page.waitForTimeout(200);
        const frozen = await snapshot(page);
        expect(frozen.sectionEffects).toEqual(held.sectionEffects);
        expect(frozen.starfield).toEqual(held.starfield);
    });
}
