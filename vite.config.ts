import { shallot } from "@dylanebert/shallot/vite";
import { defaultClientConditions, type Plugin } from "vite";

// Shallot 0.10.1-next.2 serves public assets before Vite, but omits .mjs MIME
// types. Supply the analysis runtime's type before that middleware responds.
const analysisRuntimeContentType: Plugin = {
    name: "analysis-runtime-content-type",
    configureServer(server) {
        server.middlewares.use((request, response, next) => {
            const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
            if (pathname.startsWith("/models/onnx-runtime/") && pathname.endsWith(".mjs")) {
                response.setHeader("Content-Type", "text/javascript");
            }
            next();
        });
    },
};

export default {
    plugins: [analysisRuntimeContentType, shallot()],
    resolve: {
        // The worker loads a matching same-origin runtime prepared by setup:audio.
        // Avoid embedding a second 25 MB WASM binary in the production assets.
        conditions: [...defaultClientConditions, "onnxruntime-web-use-extern-wasm"],
    },
    optimizeDeps: {
        exclude: ["onnxruntime-web", "@jgorset/beat-this"],
        // Beat This stays unbundled, but its CommonJS FFT dependency must be
        // converted to ESM for the analysis worker to start in Vite dev.
        include: ["@jgorset/beat-this > fft.js"],
    },
    worker: {
        format: "es" as const,
    },
};
