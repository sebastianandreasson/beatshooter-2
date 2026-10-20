import { type Plugin } from "@dylanebert/shallot";
import { fireProjectile } from "../combat";
import { createEnemy } from "../enemies";
import { PlayerState } from "../player";
import { PrepareCombat, ResolveCombat, Session } from "../session";
import { publishVisualEvents } from "../music-visuals/events";
import type { CombatEvent } from "../combat";
import { type Resource } from "@dylanebert/shallot";

const BurstStress: Resource<{ generation: number; beat: number }> = {
    create: () => ({ generation: -1, beat: -1 }),
};

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
    }, {
        name: "Beatshooter/VisualStress", group: "fixed", after: [ResolveCombat],
        update(world) {
            if (typeof location === "undefined" || !new URLSearchParams(location.search).has("visualStress")) return;
            const s = world.resource(Session), state = world.resource(BurstStress);
            if (state.generation !== s.generation) { state.generation = s.generation; state.beat = -1; }
            if (s.phase !== "playing" || s.combat.lastBeatIndex < 0 || state.beat === s.combat.lastBeatIndex) return;
            const beat = s.track.beats[s.combat.lastBeatIndex];
            if (!beat || s.position - beat.time < 0.04) return;
            state.beat = s.combat.lastBeatIndex;
            const events: CombatEvent[] = Array.from({ length: 16 }, (_, index) => ({
                id: ++s.combat.eventSequence, kind: "kill", amount: 24, critical: index % 4 === 0,
                x: (index % 4 - 1.5) * 4, z: (Math.floor(index / 4) - 1.5) * 4,
                simulationTime: s.combat.time,
            }));
            publishVisualEvents(world, events, s.position, s.visualPosition, s.generation);
        },
    }],
};
