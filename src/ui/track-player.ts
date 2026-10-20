import { sectionAt, type SectionAnalysis, type SectionLabel } from "../analysis/sections";

export const SECTION_STYLE: Record<SectionLabel, { name: string; color: string }> = {
    intro: { name: "Intro", color: "#79b7e7" },
    verse: { name: "Verse", color: "#82c7ad" },
    chorus: { name: "Chorus", color: "#edbd72" },
    bridge: { name: "Bridge", color: "#bd9ee5" },
    inst: { name: "Instrumental", color: "#79cbd1" },
    outro: { name: "Outro", color: "#df9eac" },
    silence: { name: "Silence", color: "#8b98a5" },
};

function clock(seconds: number): string {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** A read-only timeline: section predictions never seek or change gameplay timing. */
export function mountTrackPlayer(element: HTMLElement, accessibleName = "Track progress") {
    element.classList.add("bs-track-player");
    element.innerHTML = `
        <div class="bs-player-meta"><span class="bs-player-section"></span><span class="bs-player-time"></span></div>
        <div class="bs-player-rail">
            <div class="bs-player-sections"></div>
            <div class="bs-player-fill"></div><div class="bs-player-unplayed"></div><i class="bs-player-cursor"></i>
            <progress value="0" max="1"></progress>
        </div>
        <div class="bs-player-footer"><span class="bs-player-note"></span><span class="bs-player-next"></span></div>
        <div class="bs-player-legend" aria-label="Section colors"></div>`;
    const rail = element.querySelector<HTMLElement>(".bs-player-rail")!;
    const bands = element.querySelector<HTMLElement>(".bs-player-sections")!;
    const legend = element.querySelector<HTMLElement>(".bs-player-legend")!;
    const current = element.querySelector<HTMLElement>(".bs-player-section")!;
    const timing = element.querySelector<HTMLElement>(".bs-player-time")!;
    const note = element.querySelector<HTMLElement>(".bs-player-note")!;
    const next = element.querySelector<HTMLElement>(".bs-player-next")!;
    const progress = element.querySelector<HTMLProgressElement>("progress")!;
    progress.setAttribute("aria-label", accessibleName);
    let previous: SectionAnalysis | undefined;
    let initialized = false;
    const setText = (target: HTMLElement, text: string) => {
        if (target.textContent !== text) target.textContent = text;
    };
    return {
        render(position: number, duration: number, structure?: SectionAnalysis, practice = false) {
            const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
            const time = Number.isFinite(position) ? Math.max(0, Math.min(position, length)) : 0;
            const sections = structure?.sections ?? [];
            if (!initialized || structure !== previous) {
                initialized = true;
                previous = structure;
                bands.replaceChildren();
                legend.replaceChildren();
                const labels = new Set<SectionLabel>();
                for (const section of sections) {
                    const style = SECTION_STYLE[section.label];
                    const band = document.createElement("span");
                    band.className = "bs-player-band";
                    band.dataset.section = section.label;
                    band.dataset.start = String(section.start);
                    band.dataset.end = String(section.end);
                    band.style.left = `${section.start / structure!.duration * 100}%`;
                    band.style.width = `${(section.end - section.start) / structure!.duration * 100}%`;
                    band.style.backgroundColor = style.color;
                    band.textContent = style.name;
                    band.title = `${style.name} · ${clock(section.start)}–${clock(section.end)}`;
                    bands.append(band);
                    labels.add(section.label);
                }
                for (const label of labels) {
                    const chip = document.createElement("span");
                    chip.style.setProperty("--section-color", SECTION_STYLE[label].color);
                    chip.textContent = SECTION_STYLE[label].name;
                    legend.append(chip);
                }
                element.classList.toggle("bs-player-analyzed", sections.length > 0);
                legend.hidden = sections.length === 0;
            }
            const fraction = length ? time / length : 0;
            rail.style.setProperty("--song-progress", `${fraction * 100}%`);
            progress.value = fraction;
            const section = sectionAt(sections, time) ??
                (time === length && length > 0 ? sections.at(-1) : undefined);
            const label = section ? SECTION_STYLE[section.label].name : practice ? "Practice" : "Playing";
            setText(current, position < 0 ? "Count-in" : label);
            current.style.setProperty("--section-color", section ? SECTION_STYLE[section.label].color : "#9ce6c6");
            setText(timing, `${clock(time)} / ${practice ? "∞" : clock(length)}`);
            setText(note, sections.length ? "SONG SECTIONS" : practice ? "PRACTICE" : "");
            const following = section ? sections[sections.indexOf(section) + 1] : undefined;
            setText(next, following ? `Next: ${SECTION_STYLE[following.label].name} · ${clock(following.start)}` : "");
            const description = `${clock(time)} of ${practice ? "open practice" : clock(length)}${section ? `, ${structure?.backend === "authored" ? "" : "estimated "}${label}` : ""}`;
            if (progress.getAttribute("aria-valuetext") !== description) progress.setAttribute("aria-valuetext", description);
        },
    };
}
