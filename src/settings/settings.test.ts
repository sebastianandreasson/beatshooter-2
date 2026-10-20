import { describe, expect, test } from "bun:test";
import {
    DEFAULT_SETTINGS,
    STORAGE_KEY,
    defaultPreferences,
    loadPreferences,
    resetPreferences,
    savePreferences,
    updateBest,
    validatePreferences,
    validateSettings,
    type PreferenceStorage,
} from "./index";

function memoryStorage(initial?: string): PreferenceStorage {
    const values = new Map<string, string>(initial ? [[STORAGE_KEY, initial]] : []);
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: (key) => { values.delete(key); },
    };
}

describe("versioned preferences", () => {
    test("survive save/reload without retaining mutable runtime data", () => {
        const storage = memoryStorage();
        const value = defaultPreferences();
        value.settings.musicVolume = 0.3;
        value.settings.timingOffsetMs = -125;
        value.settings.graphics = "low";
        value.settings.reducedFlash = true;
        const scored = updateBest(value, "neon-circuit", 1200);
        expect(savePreferences(scored, storage)).toBe(true);
        expect(loadPreferences(storage)).toEqual(scored);
        expect(updateBest(scored, "neon-circuit", 500).bestScores["neon-circuit"]).toBe(1200);
    });

    test("rejects unknown schema versions, malformed JSON and invalid root types", () => {
        for (const value of ["{", "null", "[]", '{"version":99,"settings":{"masterVolume":0}}']) {
            expect(loadPreferences(memoryStorage(value))).toEqual(defaultPreferences());
        }
    });

    test("validates each field, including nonfinite values and unsafe keys", () => {
        expect(validateSettings({
            masterVolume: NaN, musicVolume: 0.2, effectsVolume: 4,
            timingOffsetMs: -251, graphics: "ultra", reducedFlash: "yes",
        })).toEqual({ ...DEFAULT_SETTINGS, musicVolume: 0.2 });
        const result = validatePreferences(JSON.parse(
            '{"version":1,"settings":{},"bestScores":{"valid":42,"negative":-1,"fraction":1.2,"constructor":8,"__proto__":9,"bad key":3}}',
        ));
        expect(result.bestScores).toEqual({ valid: 42 });
    });

    test("reset recovers corrupt storage and preserves valid best scores", () => {
        const corrupt = memoryStorage("not json");
        expect(resetPreferences(corrupt)).toEqual(defaultPreferences());
        expect(loadPreferences(corrupt)).toEqual(defaultPreferences());
        const storage = memoryStorage(JSON.stringify({
            version: 1, settings: { masterVolume: 0 }, bestScores: { demo: 123 },
        }));
        expect(resetPreferences(storage)).toEqual({
            version: 1, settings: { ...DEFAULT_SETTINGS }, bestScores: { demo: 123 },
        });
    });

    test("blocked storage never prevents a session from starting", () => {
        const storage: PreferenceStorage = {
            getItem() { throw new Error("blocked"); },
            setItem() { throw new Error("quota"); },
            removeItem() { throw new Error("blocked"); },
        };
        expect(loadPreferences(storage)).toEqual(defaultPreferences());
        expect(savePreferences(defaultPreferences(), storage)).toBe(false);
        expect(resetPreferences(storage)).toEqual(defaultPreferences());
    });

    test("retains validated local metadata but never a file or object URL", () => {
        const storage = memoryStorage();
        const value = validatePreferences({
            ...defaultPreferences(),
            lastLocal: { name: "My track.wav", bpm: 123.5, offset: 2.75, file: {}, url: "blob:old" },
        });
        expect(value.lastLocal).toEqual({ name: "My track.wav", bpm: 123.5, offset: 2.75 });
        savePreferences(value, storage);
        expect(loadPreferences(storage).lastLocal).toEqual(value.lastLocal);
        for (const patch of [{ name: "" }, { name: "bad\nname" }, { bpm: 301 }, { offset: -1 }, { offset: Infinity }]) {
            expect(validatePreferences({
                ...defaultPreferences(), lastLocal: { ...value.lastLocal, ...patch },
            }).lastLocal).toBeUndefined();
        }
    });
});
