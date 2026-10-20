import { expect, test } from "bun:test";
import { createApp, StandardPhysicsPlugin } from "@dylanebert/shallot";
import { createEnemy } from "../enemies";
import { PrepareCombat, Session } from "./index";

test("live difficulty follows raw offbeat section boundaries independently of visual settings and pause", async () => {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin] });
    try {
        const session = app.world.resource(Session);
        session.track = {
            ...session.track,
            structure: {
                version: 1, analyzerVersion: "balance-test", duration: 72, elapsedMs: 0, backend: "authored",
                sections: [{ start: 0, end: 0.37, label: "intro" }, { start: 0.37, end: 72, label: "verse" }],
            },
        };
        session.phase = "playing";
        session.preferences.settings.effectsIntensity = "off";
        session.preferences.settings.timingOffsetMs = 250;
        const enemy = createEnemy(1, { x: 10, z: 10 }, 0, session.combat.tuning);
        session.combat.enemies.push(enemy);
        session.position = 0.36;
        session.visualPosition = 0.61;
        PrepareCombat.update!(app.world);
        expect(enemy.maxHealth).toBe(24);
        session.phase = "paused";
        session.position = 0.37;
        PrepareCombat.update!(app.world);
        expect(enemy.maxHealth).toBe(24);
        session.phase = "playing";
        session.visualPosition = 0.12;
        PrepareCombat.update!(app.world);
        expect(enemy.maxHealth).toBe(26);
        expect(session.combat.healthSection).toBe(1);
        for (let i = 0; i < 10; i++) PrepareCombat.update!(app.world);
        expect(enemy.maxHealth).toBe(26);
    } finally { app.dispose(); }
});
