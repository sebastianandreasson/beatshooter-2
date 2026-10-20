import { expect, test } from "bun:test";
import { sectionAt, validateSections, type SectionAnalysis } from "./sections";
import { createAnalyzedChart } from "./chart";
import { linksegDecode } from "./vendor/linkseg/decode";
import { buildLinkSegWindows } from "./vendor/linkseg/windows";
import golden from "../../tests/fixtures/linkseg/linkseg-decode-golden.json";
import windowsGolden from "../../tests/fixtures/linkseg/linkseg-windows-golden.json";
import melGolden from "../../tests/fixtures/linkseg/mel-synthetic.json";
import { melForWindows } from "./vendor/linkseg/mel";

const structure: SectionAnalysis = {
    version: 1, analyzerVersion: "fixture", duration: 10, elapsedMs: 5, backend: "webgpu",
    sections: [{ start: 0, end: 3, label: "intro" }, { start: 3, end: 10, label: "chorus" }],
};

test("section validation requires a finite contiguous whole-track partition and copies metadata", () => {
    const valid = validateSections(structure, 10)!;
    expect(valid).toEqual(structure);
    expect(valid.sections).not.toBe(structure.sections);
    expect(valid.sections[0]).not.toBe(structure.sections[0]);
    for (const candidate of [
        null, { ...structure, sections: [] }, { ...structure, version: 2 },
        { ...structure, duration: 12 }, { ...structure, elapsedMs: NaN },
        { ...structure, sections: [{ start: 0, end: Infinity, label: "intro" }] },
        { ...structure, sections: [{ start: 0, end: 10, label: "<script>" }] },
        { ...structure, sections: [{ start: 1, end: 10, label: "intro" }] },
        { ...structure, sections: [{ start: 0, end: 9, label: "intro" }] },
        { ...structure, sections: [{ start: 0, end: 4, label: "intro" }, structure.sections[1]] },
    ]) expect(validateSections(candidate, 10)).toBeUndefined();
});

test("current section changes exactly at a boundary and does not invent count-in/tail sections", () => {
    expect(sectionAt(structure.sections, -1)).toBeUndefined();
    expect(sectionAt(structure.sections, NaN)).toBeUndefined();
    expect(sectionAt(structure.sections, 2.999)?.label).toBe("intro");
    expect(sectionAt(structure.sections, 3)?.label).toBe("chorus");
    expect(sectionAt(structure.sections, 10)).toBeUndefined();
});

test("section predictions never alter beats, downbeats, or chart identity", () => {
    const analysis = {
        schemaVersion: 1 as const, analyzerVersion: "test", duration: 10,
        beats: Array.from({ length: 20 }, (_, i) => i * 0.5),
        downbeats: [0, 2, 4, 6, 8], elapsedMs: 1, backend: "webgpu" as const,
    };
    expect(createAnalyzedChart({ ...analysis, structure })).toEqual(createAnalyzedChart(analysis));
});

test("vendored decoder reproduces upstream Python boundaries and labels, including repeated labels", () => {
    const result = linksegDecode(new Float32Array(golden.bound), new Float32Array(golden.label),
        golden.beatTimes, golden.duration);
    expect(result.labels).toEqual(golden.expected.labels);
    expect(result.times.length).toBe(golden.expected.times.length);
    for (let i = 0; i < result.times.length; i++) expect(result.times[i]!).toBeCloseTo(golden.expected.times[i]!, 8);
    expect(result.labels[0]).toBe(result.labels[1]);
});

test("vendored preprocessing preserves upstream beat quantization and window offsets", () => {
    const ramp = Float32Array.from({ length: windowsGolden.waveLen }, (_, i) => i);
    const { beatTimes, windows } = buildLinkSegWindows(windowsGolden.rawBeats, ramp);
    expect(beatTimes).toEqual(windowsGolden.expectedBeatTimes);
    for (let i = 0; i < windows.length; i++) {
        expect(windows[i]!.length).toBe(16382);
        const offset = windowsGolden.expectedBf1[i]! - windowsGolden.pad;
        expect(windows[i]![0]).toBe(Math.max(0, Math.min(ramp.length - 1, offset)));
    }
});

test("browser mel frontend matches torchaudio on an independently generated synthetic signal", () => {
    const wave = Float32Array.from({ length: 16382 }, (_, i) =>
        ((i % 97) / 48 - 1) * 0.3 + (i % 1009 === 0 ? 0.5 : 0));
    const actual = melForWindows([wave]);
    expect(actual.length).toBe(melGolden.mel.length);
    let error = 0;
    for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i]! - melGolden.mel[i]!));
    expect(error).toBeLessThan(0.005);
});
