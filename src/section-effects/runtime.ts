import type { Resource } from "@dylanebert/shallot";
import type { SectionAnalysis } from "../analysis/sections";
import type { TrackManifest } from "../tracks";
import { SectionTransitionTimeline, type SectionTransitionFrame } from "./state";

export const NO_SECTION_FRAME = new SectionTransitionTimeline(undefined, []).sample(0);

/** Shared presentation state; the combat and transport never read it. */
export const SectionEffects: Resource<{
    generation: number;
    track?: TrackManifest;
    structure?: SectionAnalysis;
    timeline: SectionTransitionTimeline;
    frame: SectionTransitionFrame;
    strength: number;
    motionAllowed: boolean;
}> = {
    create: () => ({
        generation: -1, timeline: new SectionTransitionTimeline(undefined, []),
        frame: NO_SECTION_FRAME, strength: 0, motionAllowed: false,
    }),
};
