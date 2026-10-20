import { type Plugin, type Resource, type System } from "@dylanebert/shallot";
import { sampleEnergy } from "../analysis/energy";
import { PlayerState, PresentPlayer } from "../player";
import { createMusicalTimeline, type MusicalFrame, type MusicalTimeline } from "../rhythm/visual";
import { isArenaPhase, ObserveMusic, Session } from "../session";
import type { TrackManifest } from "../tracks";
import { SectionEffects } from "../section-effects/runtime";
import { EffectDirector } from "./effects";
import { VisualEvents } from "./events";
import { MusicFloorPlugin, updateMusicFloor } from "./floor";
import { clearParticlePool, createParticlePool, renderParticles, type ParticlePool } from "./particles";

export const MusicVisuals: Resource<{
    generation: number; track?: TrackManifest; lastPosition: number; timingOffsetMs: number;
    timeline: MusicalTimeline; frame: MusicalFrame; director: EffectDirector;
    pool?: ParticlePool; intensity: number; motionAllowed: boolean; osReducedMotion: boolean;
    profileCpu: boolean; visualCpuMs: number;
}> = {
    create: () => {
        const timeline = createMusicalTimeline([]);
        return {
            generation: -1, lastPosition: 0, timingOffsetMs: 0, timeline, frame: timeline.sample(0),
            director: new EffectDirector(timeline, -1),
            intensity: 0, motionAllowed: false, osReducedMotion: false,
            profileCpu: false, visualCpuMs: 0,
        };
    },
};

export const SampleMusicalVisuals: System = {
    name: "Beatshooter/SampleMusicalVisuals", group: "setup", after: [ObserveMusic],
    update(world) {
        const s = world.resource(Session), v = world.resource(MusicVisuals);
        const settings = s.preferences.settings;
        const changedTimeline = v.generation !== s.generation || v.track !== s.track ||
            s.position < v.lastPosition - 0.001;
        if (changedTimeline) {
            v.timeline = createMusicalTimeline(s.track.beats);
        }
        // Calibration can rewind only the visual clock while raw music keeps
        // advancing. Discard old envelopes rather than replaying their births.
        if (changedTimeline || v.timingOffsetMs !== settings.timingOffsetMs) {
            v.director = new EffectDirector(v.timeline, s.generation);
            v.generation = s.generation; v.track = s.track;
            world.resource(VisualEvents).pending.length = 0;
            if (v.pool) clearParticlePool(world, v.pool);
        }
        v.timingOffsetMs = settings.timingOffsetMs;
        v.lastPosition = s.position;
        v.frame = v.timeline.sample(s.visualPosition);
        v.intensity = settings.effectsIntensity === "off" ? 0 : settings.effectsIntensity === "calm" ? 0.3 : 0.85;
        if (settings.reducedFlash || v.osReducedMotion) v.intensity = Math.min(v.intensity, 0.18);
        v.motionAllowed = v.intensity > 0 && !v.osReducedMotion && !settings.reducedFlash;
    },
};

export const PresentMusicalVisuals: System = {
    name: "Beatshooter/PresentMusicalVisuals", group: "simulation", after: [PresentPlayer],
    update(world) {
        const s = world.resource(Session), v = world.resource(MusicVisuals), player = world.resource(PlayerState);
        const cpuStart = v.profileCpu ? performance.now() : 0;
        const visible = isArenaPhase(s.phase);
        const queue = world.resource(VisualEvents);
        v.director.consume(queue.pending.splice(0), visible && v.intensity > 0);
        v.director.step(s.visualPosition, visible && v.intensity > 0);
        if (!visible) {
            v.director.clear();
            if (v.pool) clearParticlePool(world, v.pool);
        } else if (v.pool) {
            renderParticles(world, v.pool, v.director, s.visualPosition,
                s.preferences.settings.graphics === "high", v.motionAllowed, v.intensity);
        }
        const energy = sampleEnergy(s.loaded?.energy, s.visualPosition);
        const section = world.resource(SectionEffects);
        updateMusicFloor(world, {
            ...v.frame,
            intensity: visible ? v.intensity * v.frame.strength * (s.loaded?.energy ? 0.25 + energy.loudness * 0.75 : 1) : 0,
            energy: energy.loudness, bass: energy.bass,
            playerX: player.position.x, playerZ: player.position.z,
            motionAllowed: visible && v.motionAllowed,
            highQuality: s.preferences.settings.graphics === "high",
            section: visible && section.frame.index >= 0 ? {
                progress: section.frame.progress, strength: section.strength,
                mapRoll: section.mapRoll, mapDrop: section.mapDrop,
                floor: [...section.frame.palette.floor],
                line: [...section.frame.palette.line],
                accent: [...section.frame.palette.accent],
            } : undefined,
        });
        if (v.profileCpu) v.visualCpuMs = performance.now() - cpuStart;
    },
};

export const MusicVisualsPlugin: Plugin = {
    name: "Beatshooter/MusicVisuals",
    dependencies: [MusicFloorPlugin],
    initialize(world) {
        const v = world.resource(MusicVisuals);
        v.profileCpu = typeof location !== "undefined" && new URLSearchParams(location.search).has("test");
        v.pool = createParticlePool(world);
        if (typeof matchMedia === "function") {
            const preference = matchMedia("(prefers-reduced-motion: reduce)");
            v.osReducedMotion = preference.matches;
            preference.addEventListener("change", event => { v.osReducedMotion = event.matches; }, { signal: world.signal });
        }
        world.onDispose(() => {
            v.director.clear();
            world.resource(VisualEvents).pending.length = 0;
        });
    },
    systems: [SampleMusicalVisuals, PresentMusicalVisuals],
};
