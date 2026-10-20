import { BEAT_MODEL } from "../src/analysis/models";

export const modelPath = `/models/${BEAT_MODEL.file}`;
export const chunkBytes = 20 * 1024 * 1024;
export const modelParts = Array.from(
    { length: Math.ceil(BEAT_MODEL.bytes / chunkBytes) },
    (_, index) => `/models/beat-this-parts/${BEAT_MODEL.sha256}/${index}.bin`,
);
