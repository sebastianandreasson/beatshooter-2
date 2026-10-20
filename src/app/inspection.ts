import { Body, Camera, GlobalTransform, MeshMaterial, Sound, Transform, type World } from "@dylanebert/shallot";
import { worldToViewport } from "@dylanebert/shallot/rendering";
import { Arena } from "../arena";
import { PlayerState } from "../player";
import { Session, SessionEntity } from "../session";
import { MusicVisuals } from "../music-visuals";
import { MusicFloorState } from "../music-visuals/floor";
import { DashState } from "../dash/state";
import { Presentation } from "../presentation";
import { ExperiencePresentation } from "../experience";
import { EnemySpawnPresentation } from "../enemy-spawn";
import { enemySpawnPose } from "../enemy-spawn/pose";
import { SectionEffects } from "../section-effects/runtime";
import { Starfield } from "../starfield";
import { Shockwave } from "../shockwave";
import { shockwaveHeight } from "../shockwave/surface";
import { Neon } from "../neon";
import { NeonTrails } from "../neon-trails";
import { MusicStage } from "../music-stage";

/** Read-only opt-in witnesses for browser tests; never enables an on-screen overlay. */
export function installInspection(world: World): void {
    if (!new URLSearchParams(location.search).has("test")) return;
    const api = {
        snapshot() {
            const s = world.resource(Session), p = world.resource(PlayerState), arena = world.resource(Arena);
            const pose = world.storage(GlobalTransform);
            const visuals = world.resource(MusicVisuals), floor = world.resource(MusicFloorState);
            const dash = world.resource(DashState).controller;
            const presentation = world.resource(Presentation);
            const experience = world.resource(ExperiencePresentation);
            const arrivals = world.resource(EnemySpawnPresentation);
            const sections = world.resource(SectionEffects);
            const stars = world.resource(Starfield);
            const wave = world.resource(Shockwave);
            const neon = world.resource(Neon), trails = world.resource(NeonTrails);
            const stage = world.resource(MusicStage);
            const waveRadius = wave.progress * 30;
            const surfaceSamples = [waveRadius, waveRadius + 4, Math.max(0, waveRadius - 4), 0]
                .map(x => ({ x, z: 0, height: shockwaveHeight(wave.progress, wave.strength, x, 0) }));
            const transform = world.storage(Transform), materials = world.storage(MeshMaterial);
            const mesh = (eid: number) => ({
                position: {
                    x: transform.translation.x.get(eid), y: transform.translation.y.get(eid), z: transform.translation.z.get(eid),
                },
                rotation: { y: transform.rotation.y.get(eid), w: transform.rotation.w.get(eid) },
                scale: { x: transform.scale.x.get(eid), y: transform.scale.y.get(eid), z: transform.scale.z.get(eid) },
                material: materials.material.get(eid),
            });
            return {
                phase: s.phase, generation: s.generation, pending: s.pending.length,
                position: s.position, audioState: s.transport?.state,
                playbackRate: s.transport?.playbackRate ?? 0,
                simulationScale: world.time.scale,
                musicStage: {
                    frame: stage.frame ? structuredClone(stage.frame) : undefined,
                    counts: { ...stage.counts }, hasFeatures: stage.hasFeatures, cpuMs: stage.cpuMs,
                    features: { ...stage.features, spectrum: stage.features.spectrum.slice() },
                    capacity: Object.values(stage.entities).reduce((count, entities) => count + entities.length, 0),
                    samples: Object.fromEntries(Object.entries(stage.entities).map(([layer, entities]) =>
                        [layer, entities.slice(0, 2).map(mesh)])),
                },
                neon: {
                    status: neon.status, error: neon.error, frame: { ...neon.frame },
                    passes: neon.passes, dimensions: { ...neon.dimensions },
                },
                neonTrails: {
                    visibleCount: trails.visibleCount, capacity: trails.capacity,
                    samples: trails.witnesses.map(sample => ({ ...sample, mesh: mesh(sample.entity) })),
                },
                starfield: {
                    distance: stars.distance, speed: stars.speed, boost: stars.boost,
                    motionAllowed: stars.motionAllowed, entityCount: stars.stars.length,
                    samples: stars.stars.slice(0, 3).map(mesh),
                },
                sectionEffects: {
                    active: sections.frame.active, sectionIndex: sections.frame.index, label: sections.frame.label,
                    startTime: sections.frame.startTime, endTime: sections.frame.endTime,
                    progress: sections.frame.progress,
                    waveProgress: sections.frame.waveProgress,
                    anticipating: sections.frame.anticipating, anticipation: sections.frame.anticipation,
                    impact: sections.frame.impact,
                    shockwave: {
                        active: sections.strength > 0 && sections.frame.active,
                        radius: sections.strength > 0 && sections.frame.active ? sections.frame.waveProgress * 30 : 0,
                        from: structuredClone(sections.frame.from), to: structuredClone(sections.frame.to),
                    },
                    surface: {
                        peakLift: surfaceSamples[0]!.height,
                        vertexCount: arena.floorVertexCount,
                        affectedCount: wave.affectedCount,
                        samples: surfaceSamples,
                    },
                    map: {
                        position: {
                            x: transform.translation.x.get(arena.floor),
                            y: transform.translation.y.get(arena.floor),
                            z: transform.translation.z.get(arena.floor),
                        },
                        rotation: {
                            x: transform.rotation.x.get(arena.floor), y: transform.rotation.y.get(arena.floor),
                            z: transform.rotation.z.get(arena.floor), w: transform.rotation.w.get(arena.floor),
                        },
                    },
                    motionAllowed: sections.motionAllowed, strength: sections.strength,
                    palette: structuredClone(sections.frame.palette),
                    camera: {
                        position: {
                            x: transform.translation.x.get(arena.camera),
                            y: transform.translation.y.get(arena.camera),
                            z: transform.translation.z.get(arena.camera),
                        },
                        rotation: {
                            x: transform.rotation.x.get(arena.camera), y: transform.rotation.y.get(arena.camera),
                            z: transform.rotation.z.get(arena.camera), w: transform.rotation.w.get(arena.camera),
                        },
                        size: world.storage(Camera).size.get(arena.camera),
                        clearColor: world.storage(Camera).clearColor.get(arena.camera),
                    },
                },
                upgrade: {
                    pending: s.combat.upgrades.pending, offeredLevel: s.combat.upgrades.offeredLevel,
                    choices: s.combat.upgrades.choices.map(choice => ({ ...choice })),
                    ranks: { ...s.combat.upgrades.ranks },
                },
                player: {
                    position: { ...p.position }, aim: { ...p.aim }, target: { ...p.target },
                    bodyY: pose.translation.y.get(p.body),
                    velocity: { x: pose.linearVelocity.x.get(p.body), z: pose.linearVelocity.z.get(p.body) },
                },
                combat: {
                    health: s.combat.health, score: s.combat.score, kills: s.combat.kills, time: s.combat.time,
                    enemies: s.combat.enemies.length, projectiles: s.combat.projectiles.length, effects: s.combat.effects.length,
                },
                playerStats: {
                    base: { ...s.combat.playerStats.base },
                    effective: { ...s.combat.playerStats.effective },
                    modifiers: Object.fromEntries(Object.entries(s.combat.playerStats.modifiers).map(([id, modifier]) =>
                        [id, { add: { ...modifier.add }, multiply: { ...modifier.multiply } }])),
                    metrics: { ...s.combat.playerStats.metrics },
                },
                enemyHealthbars: presentation.healthbars.size,
                spawnPresentationCount: arrivals.spawns.size,
                pendingSpawns: s.combat.pendingSpawns.map(spawn => {
                    const shown = arrivals.spawns.get(spawn.enemy.id);
                    return {
                        id: spawn.enemy.id, kind: spawn.enemy.kind, x: spawn.enemy.x, z: spawn.enemy.z,
                        startTime: spawn.startTime, endTime: spawn.endTime, activateBeat: spawn.activateBeat,
                        progress: enemySpawnPose(spawn.startTime, spawn.endTime, s.position, visuals).progress,
                        body: shown ? mesh(shown.body) : undefined,
                        accents: shown?.accents.map(mesh) ?? [],
                        beams: shown ? [...shown.beams, ...shown.outline].map(mesh) : [],
                    };
                }),
                targets: s.combat.enemies.map(enemy => ({ x: enemy.x, z: enemy.z })),
                enemies: s.combat.enemies.map(enemy => {
                    const body = s.enemyBodies.get(enemy.id);
                    return {
                        id: enemy.id, kind: enemy.kind, heading: enemy.heading, spawnBar: enemy.spawnBar,
                        x: enemy.x, z: enemy.z, health: enemy.health, maxHealth: enemy.maxHealth,
                        body: body === undefined ? undefined : mesh(body),
                        accents: (presentation.enemyAccents.get(enemy.id) ?? []).map(mesh),
                    };
                }),
                projectiles: s.combat.projectiles.map(shot => {
                    const eid = presentation.projectiles.get(shot.id);
                    return {
                        id: shot.id, shooterId: shot.shooterId, collisionMask: shot.collisionMask,
                        x: shot.x, z: shot.z, velocityX: shot.velocityX, velocityZ: shot.velocityZ,
                        remainingLifetime: shot.remainingLifetime,
                        damage: shot.damage, critical: shot.critical,
                        waitingForBounce: shot.waitingForBounce, bouncesRemaining: shot.bouncesRemaining,
                        hitEnemyIds: shot.hitEnemyIds.slice(), lastBounceBeat: shot.lastBounceBeat,
                        mesh: eid === undefined ? undefined : mesh(eid),
                    };
                }),
                presentation: {
                    enemyAccentGroups: presentation.enemyAccents.size,
                    enemyAccentCount: [...presentation.enemyAccents.values()].reduce((sum, accents) => sum + accents.length, 0),
                    projectiles: presentation.projectiles.size,
                },
                experience: {
                    level: s.combat.experience.level, xp: s.combat.experience.xp,
                    requiredXp: s.combat.experience.requiredXp, totalXp: s.combat.experience.totalXp,
                    renderedDrops: experience.drops.size,
                    drops: s.combat.experience.drops.map(drop => {
                        const eid = experience.drops.get(drop.id);
                        return { ...drop, mesh: eid === undefined ? undefined : mesh(eid) };
                    }),
                },
                entityCount: [...world.query([SessionEntity])].length,
                bodyCount: [...world.query([Body])].length,
                sounds: [...world.query([Sound])].length,
                camera: arena.camera,
                dash: {
                    state: dash.status(s.position), accepted: dash.accepted, lastUsedBeat: dash.lastUsedBeat,
                    lastUsedBar: dash.lastUsedBar,
                    active: dash.active ? { ...dash.active, direction: { ...dash.active.direction },
                        origin: { ...dash.active.origin } } : undefined,
                },
                visuals: {
                    frame: { ...visuals.frame }, intensity: visuals.intensity, motionAllowed: visuals.motionAllowed,
                    osReducedMotion: visuals.osReducedMotion, activeShards: visuals.pool?.activeShards ?? 0,
                    activeRings: visuals.pool?.activeRings ?? 0, pendingBursts: visuals.director.pending.length,
                    feedback: visuals.director.feedback.length, acceptedEvents: visuals.director.accepted,
                    suppressedEvents: visuals.director.suppressed, poolCapacity: visuals.pool?.shards.length ?? 0,
                    visualCpuMs: visuals.visualCpuMs,
                    shaderStatus: floor.status, shaderInput: { ...floor.lastInput },
                    shaderError: floor.error,
                    levelUpBursts: visuals.director.bursts.filter(burst => burst.kind === "level-up")
                        .map(burst => ({ id: burst.id, birth: burst.birth, songTime: burst.songTime,
                            visualTime: burst.visualTime, amount: burst.amount, quiet: burst.quiet })),
                    particlePoses: visuals.pool ? [...visuals.pool.visible].slice(0, 8).map(eid => ({
                        x: pose.translation.x.get(eid), y: pose.translation.y.get(eid), z: pose.translation.z.get(eid),
                    })) : [],
                },
                analysis: s.analysis ? { ...s.analysis, warnings: s.analysis.warnings?.slice(),
                    structure: s.analysis.structure ? structuredClone(s.analysis.structure) : undefined } : undefined,
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
                structure: s.analyzedTrack.structure ? structuredClone(s.analyzedTrack.structure) : undefined,
                energy: s.analyzedTrack.energy ? {
                    ...s.analyzedTrack.energy,
                    loudness: s.analyzedTrack.energy.loudness.slice(),
                    bass: s.analyzedTrack.energy.bass.slice(),
                    features: s.analyzedTrack.energy.features ? structuredClone(s.analyzedTrack.energy.features) : undefined,
                } : undefined,
            } : null;
        },
        project(point: [number, number, number]) { return worldToViewport(world, world.resource(Arena).camera, point); },
    };
    Object.defineProperty(window, "__beatshooter", { value: api, configurable: true });
    world.onDispose(() => { Reflect.deleteProperty(window, "__beatshooter"); });
}
