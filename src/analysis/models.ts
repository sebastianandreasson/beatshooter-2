/** Pinned assets shared by browser caching and setup-time verification. */
export interface ModelAsset {
    file: string;
    bytes: number;
    sha256: string;
}

export const BEAT_MODEL: ModelAsset = {
    file: "beat-this.onnx",
    bytes: 83_008_106,
    sha256: "5d8a94ce99fb33a6b26df6f6d8076decd52b8fd9439e3206d9b8bcdb1c2881bd",
};

export const SECTION_MODEL: ModelAsset = {
    file: "linkseg-7c.onnx",
    bytes: 1_574_039,
    sha256: "c1dac2e094d260678d0097b85da6f5189abfe87af4b9c6f7adebaf99f4896125",
};
