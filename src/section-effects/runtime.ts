import type { Resource } from "@dylanebert/shallot";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
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
    roll: number;
    zoom: number;
    mapRoll: number;
    mapDrop: number;
    strength: number;
    motionAllowed: boolean;
    portals: number[];
    portalsVisible: boolean;
    portalMaterial?: MaterialHandle;
}> = {
    create: () => ({
        generation: -1, timeline: new SectionTransitionTimeline(undefined, []),
        frame: NO_SECTION_FRAME, roll: 0, zoom: 1, mapRoll: 0, mapDrop: 0, strength: 0,
        motionAllowed: false, portals: [], portalsVisible: false,
    }),
};
