import { expect, type Page } from "playwright/test";

/** Make a real pre-run choice without changing weapon damage or dash distance. */
export async function chooseStartingUpgrade(page: Page, id = "pickup-radius"): Promise<void> {
    await expect(page.locator('.bs-ui:is([data-phase="starting"], [data-phase="playing"])'))
        .toBeVisible({ timeout: 45_000 });
    if (await page.locator('.bs-ui[data-phase="starting"]').count()) {
        await page.locator(`.bs-start-upgrade [data-upgrade-id="${id}"]`).click();
    }
    await expect(page.locator('.bs-ui[data-phase="playing"]')).toBeVisible();
    await expect(page.locator(".bs-start-upgrade")).toBeHidden();
}
