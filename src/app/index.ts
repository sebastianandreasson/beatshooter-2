import { runApp, shallotDark, StandardAudioPlugin, StandardPhysicsPlugin } from "@dylanebert/shallot";
import { ArenaPlugin } from "../arena";
import { PlayerPlugin } from "../player";
import { mountGameUI, SessionPlugin } from "../session";
import { PresentationPlugin } from "../presentation";
import { installInspection } from "./inspection";
import { StressPlugin } from "../stress";

export async function startApp(): Promise<void> {
    const bootstrap = document.querySelector<HTMLElement>("[data-shallot-bootstrap]") ?? undefined;
    const app = await runApp({
        plugins: [
            StandardPhysicsPlugin, StandardAudioPlugin, ArenaPlugin, PlayerPlugin, SessionPlugin, PresentationPlugin,
            ...(new URLSearchParams(location.search).get("stress") === "1" ? [StressPlugin] : []),
        ],
        loading: shallotDark({ bootstrap }),
        ui: mountGameUI,
    });
    installInspection(app.world);
}
