/** Only preferences and completed scores cross the persistence boundary. */
export interface Settings {
    masterVolume: number;
    musicVolume: number;
    effectsVolume: number;
    /** Positive values advance the visual pulse; audio and combat timestamps stay unchanged. */
    timingOffsetMs: number;
    graphics: "low" | "high";
    effectsIntensity: "off" | "calm" | "standard";
    reducedFlash: boolean;
}

export interface Preferences {
    version: 1;
    settings: Settings;
    bestScores: Record<string, number>;
    /** Metadata only. A user must choose the actual file again after a reload. */
    lastLocal?: LocalTrackMetadata;
}

export interface LocalTrackMetadata {
    name: string;
    bpm: number;
    offset: number;
}

export interface PreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export const STORAGE_KEY = "beatshooter.preferences.v1";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    masterVolume: 0.75,
    musicVolume: 0.8,
    effectsVolume: 0.55,
    timingOffsetMs: 0,
    graphics: "high",
    effectsIntensity: "standard",
    reducedFlash: false,
});

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? value
        : fallback;
}

/** Invalid fields fall back independently; arbitrary runtime objects are never retained. */
export function validateSettings(value: unknown): Settings {
    const source = object(value) ? value : {};
    return {
        masterVolume: numberIn(source.masterVolume, 0, 1, DEFAULT_SETTINGS.masterVolume),
        musicVolume: numberIn(source.musicVolume, 0, 1, DEFAULT_SETTINGS.musicVolume),
        effectsVolume: numberIn(source.effectsVolume, 0, 1, DEFAULT_SETTINGS.effectsVolume),
        timingOffsetMs: numberIn(source.timingOffsetMs, -250, 250, DEFAULT_SETTINGS.timingOffsetMs),
        graphics: source.graphics === "low" ? "low" : "high",
        effectsIntensity: source.effectsIntensity === "off" || source.effectsIntensity === "calm"
            ? source.effectsIntensity : DEFAULT_SETTINGS.effectsIntensity,
        reducedFlash: typeof source.reducedFlash === "boolean"
            ? source.reducedFlash
            : DEFAULT_SETTINGS.reducedFlash,
    };
}

export function defaultPreferences(): Preferences {
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, bestScores: {} };
}

export function validatePreferences(value: unknown): Preferences {
    if (!object(value) || value.version !== 1) return defaultPreferences();
    const bestScores: Record<string, number> = {};
    if (object(value.bestScores)) {
        for (const [key, score] of Object.entries(value.bestScores).slice(0, 128)) {
            if (
                /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key)
                && key !== "constructor"
                && key !== "prototype"
                && typeof score === "number"
                && Number.isSafeInteger(score)
                && score >= 0
            ) {
                bestScores[key] = score;
            }
        }
    }
    const result: Preferences = { version: 1, settings: validateSettings(value.settings), bestScores };
    const local = value.lastLocal;
    if (
        object(local)
        && typeof local.name === "string"
        && local.name.trim().length > 0
        && local.name.length <= 255
        && !/[\u0000-\u001f]/.test(local.name)
        && typeof local.bpm === "number"
        && Number.isFinite(local.bpm) && local.bpm >= 20 && local.bpm <= 300
        && typeof local.offset === "number"
        && Number.isFinite(local.offset) && local.offset >= 0 && local.offset < 21_600
    ) {
        result.lastLocal = { name: local.name, bpm: local.bpm, offset: local.offset };
    }
    return result;
}

function browserStorage(): PreferenceStorage | undefined {
    try {
        return typeof window === "undefined" ? undefined : window.localStorage;
    } catch {
        return undefined;
    }
}

/** Storage may be denied by a browser; the game still works with in-memory defaults. */
export function loadPreferences(storage: PreferenceStorage | undefined = browserStorage()): Preferences {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        return raw ? validatePreferences(JSON.parse(raw)) : defaultPreferences();
    } catch {
        return defaultPreferences();
    }
}

export function savePreferences(
    preferences: Preferences,
    storage: PreferenceStorage | undefined = browserStorage(),
): boolean {
    if (!storage) return false;
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(validatePreferences(preferences)));
        return true;
    } catch {
        return false;
    }
}

/** Reset settings preserves valid best scores, including when individual fields are corrupt. */
export function resetPreferences(
    storage: PreferenceStorage | undefined = browserStorage(),
): Preferences {
    const preferences = loadPreferences(storage);
    preferences.settings = { ...DEFAULT_SETTINGS };
    savePreferences(preferences, storage);
    return preferences;
}

export function updateBest(preferences: Preferences, trackId: string, score: number): Preferences {
    return validatePreferences({
        ...preferences,
        bestScores: {
            ...preferences.bestScores,
            [trackId]: Math.max(preferences.bestScores[trackId] ?? 0, score),
        },
    });
}
