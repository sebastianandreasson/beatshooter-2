import { type Plugin } from "@dylanebert/shallot";
import { fireProjectile } from "../combat";
import { createEnemy } from "../enemies";
import { PlayerState } from "../player";
import { PrepareCombat, Session } from "../session";

/** Explicit ?stress=1 fixture; exercises the same physics/render/combat systems as play. */
export const StressPlugin: Plugin = {
    name: "Beatshooter/StressFixture", deterministic: false, recovery: "stateless",
    systems: [{
        name: "Beatshooter/RefillStress", group: "fixed", before: [PrepareCombat],
        update(world) {
            const s = world.resource(Session);
            if (s.phase !== "playing") return;
            const state = s.combat;
            state.tuning.enemyCap = 200;
            state.tuning.projectileCap = 500;
            state.tuning.contactDamage = 0;
            state.tuning.enemyHealth = 1000;
            while (state.enemies.length < 200) {
                const index = state.enemies.length;
                state.enemies.push(createEnemy(state.nextId++, {
                    x: ((index % 20) - 9.5) * 1.5, z: (Math.floor(index / 20) - 4.5) * 2.8,
                }, 0, state.tuning));
            }
            while (state.projectiles.length < 500) {
                const angle = state.nextId * 2.3999632297;
                fireProjectile(state, world.resource(PlayerState).position, { x: Math.cos(angle), z: Math.sin(angle) });
            }
        },
    }],
};
