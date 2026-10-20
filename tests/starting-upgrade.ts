import { expect, type Page } from "playwright/test";

/** Make the real pre-run choice; ordinary gameplay tests use the critical-damage card. */
export async function chooseStartingUpgrade(page: Page, id = "crit-damage"): Promise<void> {
    await expect(page.locator('.bs-ui:is([data-phase="starting"], [data-phase="playing"])'))
        .toBeVisible({ timeout: 45_000 });
    if (await page.locator('.bs-ui[data-phase="starting"]').count()) {
        await page.locator(`.bs-start-upgrade [data-upgrade-id="${id}"]`).click();
    }
}
