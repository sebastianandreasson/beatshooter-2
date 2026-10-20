/** Section predictions describe the recording; they never change its beat chart. */
export const SECTION_LABELS = ["intro", "verse", "chorus", "bridge", "inst", "outro", "silence"] as const;
export type SectionLabel = typeof SECTION_LABELS[number];

export interface SongSection {
    start: number;
    end: number;
    label: SectionLabel;
}

export interface SectionAnalysis {
    version: 1;
    analyzerVersion: string;
    duration: number;
    elapsedMs: number;
    backend: "webgpu" | "wasm";
    sections: SongSection[];
}

export const SECTION_ANALYZER_VERSION = "linkseg-7c-694d273-8s-v1";

/** Reject incomplete/overlapping results as a whole, rather than displaying misleading spans. */
export function validateSections(value: unknown, duration: number): SectionAnalysis | undefined {
    if (!value || typeof value !== "object" || !Number.isFinite(duration) || duration <= 0) return;
    const data = value as Partial<SectionAnalysis>;
    if (data.version !== 1 || typeof data.analyzerVersion !== "string" || !data.analyzerVersion ||
        !Number.isFinite(data.duration) || Math.abs(data.duration! - duration) > 0.05 ||
        !Number.isFinite(data.elapsedMs) || data.elapsedMs! < 0 ||
        (data.backend !== "webgpu" && data.backend !== "wasm") ||
        !Array.isArray(data.sections) || !data.sections.length || data.sections.length > 1500) return;
    let previous = 0;
    const sections: SongSection[] = [];
    for (const section of data.sections) {
        if (!section || !Number.isFinite(section.start) || !Number.isFinite(section.end) ||
            section.start !== previous || section.end <= section.start || section.end > data.duration! ||
            !SECTION_LABELS.includes(section.label)) return;
        sections.push({ start: section.start, end: section.end, label: section.label });
        previous = section.end;
    }
    if (previous !== data.duration) return;
    return { ...data, sections } as SectionAnalysis;
}

export function sectionAt(sections: readonly SongSection[], position: number): SongSection | undefined {
    if (!Number.isFinite(position) || position < 0) return;
    let low = 0, high = sections.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        const section = sections[mid]!;
        if (position < section.start) high = mid - 1;
        else if (position >= section.end) low = mid + 1;
        else return section;
    }
}
