import type { Resource, World } from "@dylanebert/shallot";
import type { CombatEvent } from "../combat";

export interface MusicEvent extends CombatEvent {
    songTime: number;
    visualTime: number;
    generation: number;
    /** Authored timestamp for commands already on the musical grid. */
    beatTime?: number;
}

export const VisualEvents: Resource<{ pending: MusicEvent[]; dropped: number }> = {
    create: () => ({ pending: [], dropped: 0 }),
};
export const MAX_EVENT_QUEUE = 256;
export const eventPriority = (kind: CombatEvent["kind"]) =>
    kind === "player-hit" ? 5 : kind === "level-up" ? 4 : kind === "kill" ? 3 : kind === "hit" ? 2 : 1;

/** Called at the fixed-step boundary, without changing any combat state. */
export function publishVisualEvents(
    world: World, events: readonly CombatEvent[], songTime: number,
    visualTime: number, generation: number, beatTime?: number,
): void {
    const queue = world.resource(VisualEvents);
    for (const event of events) {
        if (queue.pending.length >= MAX_EVENT_QUEUE) {
            const priority = eventPriority(event.kind);
            const replace = queue.pending.findIndex(item => eventPriority(item.kind) < priority);
            queue.dropped++;
            if (replace < 0) continue;
            queue.pending.splice(replace, 1);
        }
        queue.pending.push({ ...event, songTime, visualTime, generation, beatTime });
    }
}
