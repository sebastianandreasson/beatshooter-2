import { resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "./fixtures";

test.setTimeout(60_000);

async function importDemo(page: Page): Promise<void> {
    await page.goto("/");
    await expect(page.locator('.bs-ui[data-phase="menu"]')).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "Import local audio", exact: true }).click();
    await page.locator("#bs-audio-file").setInputFiles(resolve("public/tracks/neon-circuit.wav"));
    await expect(page.locator('.bs-analysis[data-analysis-state="error"]')).toBeVisible();
}

test("the real analysis worker reaches model loading", async ({ page }) => {
    let modelRequests = 0;
    // Keep this check independent of downloaded weights and GPU inference.
    // The worker must load its real dependencies before it can request a model.
    await page.route("**/models/beat-this.onnx", route => {
        modelRequests++;
        return route.fulfill({ status: 404, body: "Intentionally missing test model" });
    });
    await importDemo(page);
    expect(modelRequests, "The analysis worker must start before reporting a missing model").toBe(1);
});

test("analysis failures retain their recovery instructions", async ({ page }) => {
    const message = "Automatic analysis needs WebGPU. Use a compatible browser or manual BPM and offset.";
    await page.route(/\/(?:assets\/worker-[^/]+\.js|src\/analysis\/worker\.ts)(?:\?.*)?$/, route =>
        route.fulfill({
            contentType: "application/javascript",
            headers: { "Cross-Origin-Embedder-Policy": "require-corp" },
            body: `self.onmessage = () => self.postMessage({ type: "error", message: ${JSON.stringify(message)} });`,
        }));
    await importDemo(page);
    await expect(page.locator('[data-value="analysis-message"]')).toHaveText(message);
});

test("development serves analysis runtime modules with a JavaScript content type", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "development", "Exercises the development asset middleware.");
    // A tiny runtime-shaped module catches serving errors without model downloads.
    const directory = resolve("public/models/onnx-runtime");
    const fileName = `runtime-check-${crypto.randomUUID()}.mjs`;
    const filePath = resolve(directory, fileName);
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(filePath, 'export default "runtime loaded";\n');
        await page.goto("/");
        const result = await page.evaluate(async (url) => {
            try { return (await import(url)).default; }
            catch (error) { return error instanceof Error ? error.message : String(error); }
        }, `/models/onnx-runtime/${fileName}`);
        expect(result).toBe("runtime loaded");
    } finally {
        await rm(filePath, { force: true });
    }
});
