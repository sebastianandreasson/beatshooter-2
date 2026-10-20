import { shallot } from "@dylanebert/shallot/vite";
import { defaultClientConditions } from "vite";

export default {
    plugins: [shallot()],
    resolve: {
        // The worker loads a matching same-origin runtime prepared by setup:audio.
        // Avoid embedding a second 25 MB WASM binary in the production assets.
        conditions: [...defaultClientConditions, "onnxruntime-web-use-extern-wasm"],
    },
    optimizeDeps: {
        exclude: ["onnxruntime-web", "@jgorset/beat-this"],
    },
    worker: {
        format: "es" as const,
    },
};
