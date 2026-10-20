import { runApp, shallotDark, StandardAudioPlugin, StandardPhysicsPlugin } from "@dylanebert/shallot";
import { ArenaPlugin } from "../arena";
import { PlayerPlugin } from "../player";
import { mountGameUI, SessionPlugin } from "../session";
import { PresentationPlugin } from "../presentation";
import { installInspection } from "./inspection";
import { StressPlugin } from "../stress";
import { MusicVisualsPlugin } from "../music-visuals";
import { DashPlugin } from "../dash";
import { ExperiencePlugin } from "../experience";
import { EnemySpawnPlugin } from "../enemy-spawn";
import { SectionEffectsPlugin } from "../section-effects";
import { StarfieldPlugin } from "../starfield";
import { ShockwavePlugin } from "../shockwave";
import { NeonPlugin } from "../neon";
import { NeonTrailsPlugin } from "../neon-trails";
import { MusicStagePlugin } from "../music-stage";

export async function startApp(): Promise<void> {
    const bootstrap = document.querySelector<HTMLElement>("[data-shallot-bootstrap]") ?? undefined;
    const app = await runApp({
        plugins: [
            StandardPhysicsPlugin, StandardAudioPlugin, ArenaPlugin, PlayerPlugin, SessionPlugin, DashPlugin,
            MusicVisualsPlugin, SectionEffectsPlugin, ShockwavePlugin, StarfieldPlugin, EnemySpawnPlugin,
            PresentationPlugin, ExperiencePlugin, NeonPlugin, NeonTrailsPlugin, MusicStagePlugin,
            ...(new URLSearchParams(location.search).get("stress") === "1" ? [StressPlugin] : []),
        ],
        loading: shallotDark({ bootstrap }),
        ui: mountGameUI,
    });
    installInspection(app.world);
}
