export const ENCOUNTER_IDS = [
    "mixed-assault", "swarm-nest", "marksman-outpost", "spinner-crossfire", "elite-hunt", "pulse-grid",
] as const;
export type EncounterId = typeof ENCOUNTER_IDS[number];

export interface EncounterDefinition {
    id: EncounterId;
    title: string;
    description: string;
    threat: "low" | "medium" | "high";
    rewardPercent: number;
    density: number;
}

export const ENCOUNTERS: Readonly<Record<EncounterId, EncounterDefinition>> = {
    "mixed-assault": {
        id: "mixed-assault", title: "Mixed Assault", threat: "low", rewardPercent: 0, density: 1,
        description: "Balanced enemies approach from alternating sectors. Normal XP.",
    },
    "swarm-nest": {
        id: "swarm-nest", title: "Swarm Nest", threat: "medium", rewardPercent: 10, density: 1,
        description: "Twice as many weaker chasers. Each carries half the ordinary XP.",
    },
    "marksman-outpost": {
        id: "marksman-outpost", title: "Marksman Outpost", threat: "medium", rewardPercent: 10, density: 0.8,
        description: "Rangers lock visible firing lanes for a full bar before their volley.",
    },
    "spinner-crossfire": {
        id: "spinner-crossfire", title: "Spinner Crossfire", threat: "medium", rewardPercent: 10, density: 0.75,
        description: "Separated spinner groups alternate firing bars, supported by a few chasers.",
    },
    "elite-hunt": {
        id: "elite-hunt", title: "Elite Hunt", threat: "high", rewardPercent: 0, density: 0.85,
        description: "An announced elite fires alternating six-way patterns. Defeat it and survive for bonus XP.",
    },
    "pulse-grid": {
        id: "pulse-grid", title: "Pulse Grid", threat: "high", rewardPercent: 20, density: 0.65,
        description: "Marked floor tiles strike on main beats. Open corridors always remain safe.",
    },
};

export function isEncounterId(value: unknown): value is EncounterId {
    return typeof value === "string" && (ENCOUNTER_IDS as readonly string[]).includes(value);
}

/** The same immutable playlist seed always produces the same readable route. */
export function generateEncounterOffers(seed: number, songCount: number): readonly (readonly EncounterId[])[] {
    if (!Number.isSafeInteger(songCount) || songCount < 1 || songCount > 1000) {
        throw new RangeError("A run needs between one and 1,000 song slots.");
    }
    let randomState = seed >>> 0;
    const random = () => {
        randomState = (randomState + 0x6D2B79F5) >>> 0;
        let value = randomState;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const rows: EncounterId[][] = [];
    let previous = "";
    for (let stage = 0; stage < songCount; stage++) {
        const pool = ENCOUNTER_IDS.slice(1, stage < 2 ? 4 : undefined);
        const pairs: [EncounterId, EncounterId][] = [];
        for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
            if (`${pool[i]}:${pool[j]}` !== previous) pairs.push([pool[i]!, pool[j]!]);
        }
        const selected = pairs[Math.floor(random() * pairs.length)]!;
        previous = `${selected[0]}:${selected[1]}`;
        // Shuffle the display positions without changing the three choices.
        const row: EncounterId[] = ["mixed-assault", ...selected];
        for (let i = row.length - 1; i > 0; i--) {
            const other = Math.floor(random() * (i + 1));
            [row[i], row[other]] = [row[other]!, row[i]!];
        }
        rows.push(row);
    }
    return rows;
}

/** Completion-only: callers commit this once together with the cleared song. */
export function encounterReward(
    id: EncounterId, ordinaryEarnedXp: number, entryRequiredXp: number, eliteDefeated: boolean,
): number {
    if (!isEncounterId(id) || !Number.isSafeInteger(ordinaryEarnedXp) || ordinaryEarnedXp < 0
        || !Number.isSafeInteger(entryRequiredXp) || entryRequiredXp < 1) {
        throw new RangeError("Invalid encounter reward inputs.");
    }
    const cap = Math.floor(entryRequiredXp / 2);
    if (id === "elite-hunt") return eliteDefeated ? cap : 0;
    return Math.min(cap, Math.floor(ordinaryEarnedXp * ENCOUNTERS[id].rewardPercent / 100));
}
export const encounterBonus = encounterReward;
