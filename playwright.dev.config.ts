import config from "./playwright.config";

// Production bundling can hide development-only worker dependency failures.
// Run the same analysis checks against Vite's native development module graph.
export default {
    ...config,
    testMatch: "tests/analysis.e2e.ts",
    projects: [{ name: "development" }],
    use: { ...config.use, baseURL: "http://127.0.0.1:4176" },
    webServer: {
        ...config.webServer,
        command: "bun run dev --port 4176 --strictPort",
        url: "http://127.0.0.1:4176",
        reuseExistingServer: false,
    },
};
