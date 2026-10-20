import { Body, GlobalTransform, Sound, type World } from "@dylanebert/shallot";
import { worldToViewport } from "@dylanebert/shallot/rendering";
import { Arena } from "../arena";
import { PlayerState } from "../player";
import { Session, SessionEntity } from "../session";
import { MusicVisuals } from "../music-visuals";
import { MusicFloorState } from "../music-visuals/floor";

/** Read-only opt-in witnesses for browser tests; never enables an on-screen overlay. */
export function installInspection(world: World): void {
    if (!new URLSearchParams(location.search).has("test")) return;
    const api = {
        snapshot() {
            const s = world.resource(Session), p = world.resource(PlayerState), arena = world.resource(Arena);
            const pose = world.storage(GlobalTransform);
            const visuals = world.resource(MusicVisuals), floor = world.resource(MusicFloorState);
            return {
                phase: s.phase, generation: s.generation, pending: s.pending.length,
                position: s.position, audioState: s.transport?.state,
                player: {
                    position: { ...p.position }, aim: { ...p.aim }, target: { ...p.target },
                    bodyY: pose.translation.y.get(p.body),
                    velocity: { x: pose.linearVelocity.x.get(p.body), z: pose.linearVelocity.z.get(p.body) },
                },
                combat: {
                    health: s.combat.health, score: s.combat.score, kills: s.combat.kills, time: s.combat.time,
                    enemies: s.combat.enemies.length, projectiles: s.combat.projectiles.length, effects: s.combat.effects.length,
                },
                targets: s.combat.enemies.map(enemy => ({ x: enemy.x, z: enemy.z })),
                entityCount: [...world.query([SessionEntity])].length,
                bodyCount: [...world.query([Body])].length,
                sounds: [...world.query([Sound])].length,
                camera: arena.camera,
                visuals: {
                    frame: { ...visuals.frame }, intensity: visuals.intensity, motionAllowed: visuals.motionAllowed,
                    osReducedMotion: visuals.osReducedMotion, activeShards: visuals.pool?.activeShards ?? 0,
                    activeRings: visuals.pool?.activeRings ?? 0, pendingBursts: visuals.director.pending.length,
                    feedback: visuals.director.feedback.length, acceptedEvents: visuals.director.accepted,
                    suppressedEvents: visuals.director.suppressed, poolCapacity: visuals.pool?.shards.length ?? 0,
                    visualCpuMs: visuals.visualCpuMs,
                    shaderStatus: floor.status, shaderInput: { ...floor.lastInput },
                    shaderError: floor.error,
                    particlePoses: visuals.pool ? [...visuals.pool.visible].slice(0, 8).map(eid => ({
                        x: pose.translation.x.get(eid), y: pose.translation.y.get(eid), z: pose.translation.z.get(eid),
                    })) : [],
                },
                analysis: s.analysis ? { ...s.analysis, warnings: s.analysis.warnings?.slice() } : undefined,
                preview: { active: s.preview, position: s.transport?.position ?? 0, until: s.previewUntil },
                chart: {
                    id: s.track.id, bpm: s.track.bpm, beatsPerBar: s.track.beatsPerBar,
                    beatCount: s.track.beats.length, downbeatCount: s.track.beats.filter(beat => beat.downbeat).length,
                },
            };
        },
        /** Copies analysis metadata; never exposes audio bytes or mutable session data. */
        analysis() {
            const s = world.resource(Session);
            return s.analyzedTrack ? {
                ...s.analyzedTrack,
                beats: s.analyzedTrack.beats.slice(),
                downbeats: s.analyzedTrack.downbeats.slice(),
                energy: s.analyzedTrack.energy ? {
                    ...s.analyzedTrack.energy,
                    loudness: s.analyzedTrack.energy.loudness.slice(),
                    bass: s.analyzedTrack.energy.bass.slice(),
                } : undefined,
            } : null;
        },
        project(point: [number, number, number]) { return worldToViewport(world, world.resource(Arena).camera, point); },
    };
    Object.defineProperty(window, "__beatshooter", { value: api, configurable: true });
    world.onDispose(() => { Reflect.deleteProperty(window, "__beatshooter"); });
}
