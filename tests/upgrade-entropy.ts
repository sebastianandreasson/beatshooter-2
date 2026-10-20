import type { Page } from "playwright";

/**
 * Keep combat scenarios reproducible at the application's upgrade entropy
 * boundary, without changing its startup flow or exposing a game-state mutator.
 * A single seed repeats for legacy retry checks; a sequence must be consumed once.
 */
export async function installUpgradeEntropy(page: Page, seeds: readonly number[] = [2026]): Promise<void> {
    await page.addInitScript(seeds => {
        const native = crypto.getRandomValues.bind(crypto);
        let index = 0;
        crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
            const result = native(array);
            if (array instanceof Uint32Array && array.length === 1) {
                const seed = seeds.length === 1 ? seeds[0] : seeds[index++];
                if (seed === undefined) throw new Error("Upgrade entropy fixture was consumed too many times.");
                array[0] = seed;
            }
            return result;
        };
    }, [...seeds]);
}
