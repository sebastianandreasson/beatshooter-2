import { test as base } from "playwright/test";
import { installUpgradeEntropy } from "./upgrade-entropy";

export { expect } from "playwright/test";
export type { Page, Locator } from "playwright/test";

export const test = base.extend<{
    upgradeSeeds: readonly number[] | null;
    _upgradeEntropy: void;
}>({
    upgradeSeeds: [[2026], { option: true }],
    _upgradeEntropy: [async ({ page, upgradeSeeds }, use) => {
        if (upgradeSeeds) await installUpgradeEntropy(page, upgradeSeeds);
        await use();
    }, { auto: true }],
});
