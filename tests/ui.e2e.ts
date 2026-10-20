import { expect, test, type Locator, type Page } from "playwright/test";

const preferencesKey = "beatshooter.preferences.v1";
type DelayedPreviewWindow = Window & {
    __uiFileReadStarted?: boolean;
    __uiReleaseFileRead?: () => void;
};

test.setTimeout(60_000);

async function boot(page: Page): Promise<void> {
    await page.goto("/");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 45_000 });
}

async function expectNoHorizontalOverflow(element: Locator): Promise<void> {
    expect(await element.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
}

function wav(duration = 1.2): Buffer {
    const samples = Math.floor(8000 * duration);
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`session menu, settings, and import remain usable at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await boot(page);
        await expectNoHorizontalOverflow(page.locator(".bs-menu"));
        await expect(page.getByRole("heading", { name: "Neon Circuit", exact: true })).toBeVisible();
        await expect(page.locator('[data-value="demo-duration"]')).toHaveText("1:12");
        await expect(page.getByRole("region", { name: "How to play" })).toContainText("Move");
        for (const name of ["Enter the arena", "Practice", "Import local audio"]) {
            const button = page.getByRole("button", { name, exact: true });
            await button.scrollIntoViewIfNeeded();
            await expect(button).toBeInViewport();
            await expect(button).toBeEnabled();
        }
        if (viewport.width === 1280) {
            expect(await page.locator(".bs-menu").evaluate((element) => element.scrollHeight))
                .toBeLessThanOrEqual(viewport.height);
        }
        await page.getByRole("button", { name: "Open settings" }).click();
        const settings = page.locator('[data-modal="settings"]');
        await expect(settings).toBeVisible();
        await expectNoHorizontalOverflow(settings);
        for (const name of ["Master", "Music", "Effects", "Visual timing offset"]) {
            const slider = page.getByRole("slider", { name, exact: true });
            await slider.scrollIntoViewIfNeeded();
            await expect(slider).toBeInViewport();
        }
        await expect(page.locator(".bs-setting-help").first()).toContainText("Audio and combat timestamps stay unchanged");
        await page.getByRole("button", { name: "Reset settings", exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", { name: "Reset settings", exact: true })).toBeInViewport();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Import local audio", exact: true }).click();
        const local = page.locator('[data-modal="import"]');
        await expectNoHorizontalOverflow(local);
        await page.getByRole("button", { name: "Play this track", exact: true }).click();
        await expect(page.locator('[data-value="import-error"]')).toContainText("Choose an audio file");
        await expect(page.locator("#bs-audio-file")).toBeFocused();
        await page.getByRole("button", { name: "Preview with metronome", exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", { name: "Preview with metronome", exact: true })).toBeInViewport();
        await testInfo.attach(`import-${viewport.width}`, {
            body: await page.screenshot(), contentType: "image/png",
        });
    });
}

test("settings traps focus, makes the menu inert, and restores focus on Escape", async ({ page }) => {
    await boot(page);
    const opener = page.getByRole("button", { name: "Open settings" });
    await opener.click();
    const close = page.getByRole("button", { name: "Close settings", exact: true });
    const reset = page.getByRole("button", { name: "Reset settings", exact: true });
    await expect(close).toBeFocused();
    await expect(page.locator(".bs-menu")).toHaveJSProperty("inert", true);
    await page.keyboard.press("Shift+Tab");
    await expect(reset).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-modal="settings"]')).toBeHidden();
    await expect(page.locator(".bs-menu")).toHaveJSProperty("inert", false);
    await expect(opener).toBeFocused();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible();
});

test("local tempo metadata survives reload but the file must be selected again", async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "My café practice.wav", mimeType: "audio/wav", buffer: wav(),
    });
    await page.locator("#bs-local-bpm").fill("137.5");
    await page.locator("#bs-local-offset").fill("0.2");
    await page.getByRole("button", { name: "Play this track", exact: true }).click();
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), preferencesKey);
    expect(saved.lastLocal).toEqual({ name: "My café practice.wav", bpm: 137.5, offset: 0.2 });
    expect(saved.lastLocal.file).toBeUndefined();
    expect(saved.lastLocal.url).toBeUndefined();
    await page.reload();
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await expect(page.locator("#bs-local-bpm")).toHaveValue("137.5");
    await expect(page.locator("#bs-local-offset")).toHaveValue("0.2");
    await expect(page.locator('[data-value="local-reselect"]')).toContainText("My café practice.wav");
    expect(await page.locator("#bs-audio-file").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
    await page.getByRole("button", { name: "Play this track", exact: true }).click();
    await expect(page.locator('[data-value="import-error"]')).toContainText("Choose an audio file");

    // Saved defaults are applied once; another menu render must not discard an edit.
    await page.locator("#bs-local-bpm").fill("142");
    await page.locator("#bs-local-offset").fill("0.3");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator("#bs-reduced").check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await expect(page.locator("#bs-local-bpm")).toHaveValue("142");
    await expect(page.locator("#bs-local-offset")).toHaveValue("0.3");
});

test("calibration shows Stop while its file is loading and cancellation keeps the menu usable", async ({ page }) => {
    await page.addInitScript(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            const bytes = await read.call(this);
            if (this.name === "ui-delayed.wav") {
                (window as DelayedPreviewWindow).__uiFileReadStarted = true;
                await new Promise<void>((resolve) => {
                    (window as DelayedPreviewWindow).__uiReleaseFileRead = resolve;
                });
            }
            return bytes;
        };
    });
    await boot(page);
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await page.locator("#bs-audio-file").setInputFiles({
        name: "ui-delayed.wav", mimeType: "audio/wav", buffer: wav(3),
    });
    await page.getByRole("button", { name: "Preview with metronome", exact: true }).click();
    await page.waitForFunction(() => (window as DelayedPreviewWindow).__uiFileReadStarted);
    await expect(page.getByRole("button", { name: "Stop calibration preview", exact: true })).toBeVisible();
    // A settings-independent UI update must not reset the loading-state label.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Stop calibration preview", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop calibration preview", exact: true }).click();
    await page.evaluate(() => (window as DelayedPreviewWindow).__uiReleaseFileRead!());
    await expect(page.getByRole("button", { name: "Preview with metronome", exact: true })).toBeVisible();
    await expect(page.locator('[data-value="import-error"]')).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Practice", exact: true })).toBeEnabled();
});
