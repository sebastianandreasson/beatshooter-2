import type { SongSection } from "../analysis/sections";
import type { Enemy } from "../enemies";
import type { CombatState } from "./index";
import { advanceEncounterDifficulty } from "../encounters/runtime";

export const SECTION_HEALTH_GAIN = 1.1;

/** Integer capacities are always derived from the original health, never rounded repeatedly. */
export function scaleEnemyHealth(enemy: Enemy, sectionIndex: number): void {
    const capacity = Math.min(Number.MAX_SAFE_INTEGER,
        Math.max(1, Math.round(enemy.baseHealth * SECTION_HEALTH_GAIN ** sectionIndex)));
    const fraction = enemy.maxHealth > 0 ? enemy.health / enemy.maxHealth : 0;
    enemy.health = enemy.health > 0 ? Math.max(1, Math.min(capacity, Math.round(capacity * fraction))) : 0;
    enemy.maxHealth = capacity;
}

/** Raw song position owns difficulty, independently of visual effects or beat detection gaps. */
export function advanceSectionDifficulty(
    combat: CombatState, sections: readonly SongSection[] | undefined, position: number,
): void {
    if (combat.encounter) {
        advanceEncounterDifficulty(combat, position);
        return;
    }
    if (combat.defeated || !sections?.length || !Number.isFinite(position) || position < 0) return;
    let low = 0, high = sections.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (sections[mid]!.start <= position) low = mid + 1;
        else high = mid;
    }
    const index = low - 1;
    // First section is baseline. Held frames, duplicate observations and backward
    // observations cannot award another boost; a fresh combat state resets it.
    if (index <= combat.healthSection) return;
    combat.healthSection = index;
    for (const enemy of combat.enemies) scaleEnemyHealth(enemy, index);
    for (const spawn of combat.pendingSpawns) scaleEnemyHealth(spawn.enemy, index);
}
