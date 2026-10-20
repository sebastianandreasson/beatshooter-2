import { describe, expect, test } from "bun:test";
import { beatAtPosition, BeatCursor, generateTimeline, validateTimeline } from "./timeline";
import { MusicTransport } from "./transport";

class FakeParam {
    value = 1;
    automation: { kind: string; value?: number; time: number }[] = [];
    setValueAtTime(value: number, time = 0) {
        this.value = value;
        this.automation.push({ kind: "set", value, time });
    }
    exponentialRampToValueAtTime(value: number, time = 0) {
        this.value = value;
        this.automation.push({ kind: "exponential", value, time });
    }
    linearRampToValueAtTime(value: number, time = 0) {
        this.value = value;
        this.automation.push({ kind: "linear", value, time });
    }
    cancelScheduledValues(time: number) {
        this.automation.push({ kind: "cancel", time });
    }
}

class FakeNode {
    gain = new FakeParam();
    frequency = new FakeParam();
    playbackRate = new FakeParam();
    buffer: AudioBuffer | null = null;
    type = "sine";
    onended: (() => void) | null = null;
    starts: number[][] = [];
    stopped = false;
    stops: (number | undefined)[] = [];
    connections = 0;
    connect() { this.connections++; }
    disconnect() { this.connections = 0; }
    start(...args: number[]) { this.starts.push(args); }
    stop(time?: number) {
        this.stopped = true;
        this.stops.push(time);
    }
}

class FakeContext {
    currentTime = 10;
    state: AudioContextState = "running";
    destination = new FakeNode();
    sources: FakeNode[] = [];
    oscillators: FakeNode[] = [];
    gains: FakeNode[] = [];
    createGain() {
        const node = new FakeNode();
        this.gains.push(node);
        return node;
    }
    createBufferSource() {
        const node = new FakeNode();
        this.sources.push(node);
        return node;
    }
    createOscillator() {
        const node = new FakeNode();
        this.oscillators.push(node);
        return node;
    }
    async resume() { this.state = "running"; }
}

const testTrack = (duration = 4) => ({
    duration,
    bpm: 120,
    beats: generateTimeline(duration, 120),
    buffer: { duration } as AudioBuffer,
    countInBeats: 0,
});

function setup() {
    const clock = new FakeContext();
    const transport = new MusicTransport(clock as unknown as AudioContext);
    return { clock, transport };
}

describe("authored timelines", () => {
    test("generates exact times without repeated addition drift", () => {
        const beats = generateTimeline(72, 120);
        expect(beats.length).toBe(144);
        expect(beats[0]).toEqual({ time: 0, index: 0, bar: 0, beatInBar: 0, downbeat: true });
        expect(beats[143]!.time).toBe(71.5);
        expect(beats[4]!.downbeat).toBe(true);
        validateTimeline(beats, 72);
    });

    test("offset and invalid timing inputs are explicit", () => {
        expect(generateTimeline(3, 120, 0.3).map((b) => b.time)).toEqual([0.3, 0.8, 1.3, 1.8, 2.3, 2.8]);
        for (const bpm of [0, -1, NaN, 301]) expect(() => generateTimeline(3, bpm)).toThrow();
        expect(() => generateTimeline(3, 120, 3)).toThrow("before the audio ends");
        expect(() => generateTimeline(3, 120, -1)).toThrow();
        const invalid = generateTimeline(3, 120);
        invalid[1] = { ...invalid[1]!, time: 0 };
        expect(() => validateTimeline(invalid, 3)).toThrow("increasing timestamp");
    });

    test("every crossed beat is delivered once and seeking drops old commands", () => {
        const cursor = new BeatCursor(generateTimeline(5, 120));
        cursor.reset(-2);
        expect(cursor.cross(-0.1)).toEqual([]);
        expect(cursor.cross(0).map((b) => b.index)).toEqual([0]);
        expect(cursor.cross(1.6).map((b) => b.index)).toEqual([1, 2, 3]);
        expect(cursor.cross(1.6)).toEqual([]);
        cursor.reset(3, false);
        expect(cursor.cross(3)).toEqual([]);
        expect(cursor.cross(3.5).map((b) => b.index)).toEqual([7]);
        cursor.reset(0);
        expect(cursor.cross(0).map((b) => b.index)).toEqual([0]);
    });

    test("visual pulses follow authored timestamps including variable tempo", () => {
        const beats = generateTimeline(3, 120, 0.2);
        beats[2] = { ...beats[2]!, time: 1.4 };
        expect(beatAtPosition(beats, -0.1)).toBeUndefined();
        expect(beatAtPosition(beats, 0.19)).toBeUndefined();
        expect(beatAtPosition(beats, 1.3)?.index).toBe(1);
        expect(beatAtPosition(beats, 1.4)?.index).toBe(2);
        expect(beatAtPosition(beats, 100)?.index).toBe(5);
    });

    test("pickup bars and inferred unaccented boundaries retain explicit musical phase", () => {
        const beats = [
            { time: 0.2, index: 0, bar: 0, beatInBar: 2, downbeat: false },
            { time: 0.7, index: 1, bar: 1, beatInBar: 0, downbeat: true },
            { time: 1.2, index: 2, bar: 1, beatInBar: 1, downbeat: false },
            { time: 1.7, index: 3, bar: 1, beatInBar: 2, downbeat: false },
            { time: 2.2, index: 4, bar: 2, beatInBar: 0, downbeat: false },
        ];
        validateTimeline(beats, 3);
        expect(beatAtPosition(beats, 0.5)?.beatInBar).toBe(2);
        expect(beatAtPosition(beats, 2.5)?.downbeat).toBe(false);
        expect(() => validateTimeline([
            { ...beats[0]!, downbeat: true }, ...beats.slice(1),
        ], 3)).toThrow("bar information");
        expect(() => validateTimeline([
            { ...beats[0]!, bar: 1 }, ...beats.slice(1),
        ], 3)).toThrow("bar zero");
        expect(() => validateTimeline(beats, NaN)).toThrow("duration");
    });
});

describe("music transport against an injected audio clock", () => {
    test("slowdown integrates the audible rate, stops exactly on the chosen beat, and resumes without replay", async () => {
        const { clock, transport } = setup();
        await transport.start({ ...testTrack(), metronome: true });
        clock.currentTime = 10.24;
        const indices = transport.observe().beats.map((beat) => beat.index);
        expect(transport.beginSlowdown(1)).toBe(true);
        const duration = 2 * 0.8 / 1.12;
        const end = 10.24 + duration;
        expect(transport.slowing).toBe(true);
        expect(transport.slowdownTarget).toBe(1);
        expect(clock.sources[0]!.playbackRate.automation.slice(0, 2)).toEqual([
            { kind: "cancel", time: 10.24 },
            { kind: "set", value: 1, time: 10.24 },
        ]);
        expect(clock.sources[0]!.playbackRate.automation[2]).toMatchObject({
            kind: "linear", value: 0.12,
        });
        expect(clock.sources[0]!.playbackRate.automation[2]!.time).toBeCloseTo(end);
        expect(clock.sources[0]!.stops[0]).toBeCloseTo(end);
        let pausedOnce = 0;
        for (let part = 1; part <= 20; part++) {
            clock.currentTime = 10.24 + duration * part / 20;
            const observation = transport.observe();
            indices.push(...observation.beats.map((beat) => beat.index));
            pausedOnce += Number(observation.slowedToPause === true);
            if (part === 10) {
                expect(transport.position).toBeCloseTo(0.2 + duration * 0.39);
                expect(transport.playbackRate).toBeCloseTo(0.56);
                expect(transport.slowdownProgress).toBeCloseTo(duration * 0.39 / 0.8);
            }
            if (part === 20) {
                expect(observation.pausedReason).toBe("upgrade");
                expect(observation.position).toBe(1);
                expect(observation.beats.at(-1)?.scheduledTime).toBeCloseTo(end);
            }
        }
        expect(indices).toEqual([0, 1, 2]);
        expect(pausedOnce).toBe(1);
        expect(transport.slowing).toBe(false);
        expect(transport.slowdownProgress).toBe(1);
        expect(transport.playbackRate).toBe(0);
        expect(transport.observe().slowedToPause).toBeUndefined();
        clock.currentTime = 30;
        expect(transport.position).toBe(1);
        await transport.resume();
        expect(transport.slowdownProgress).toBe(0);
        expect(transport.playbackRate).toBe(1);
        expect(clock.sources[1]!.starts[0]).toEqual([30.04, 1]);
        clock.currentTime = 30.34;
        expect(transport.observe().beats).toEqual([]);
        clock.currentTime = 30.55;
        expect(transport.observe().beats.map((beat) => beat.index)).toEqual([3]);
        transport.dispose();
    });

    test("slowdown replaces future metronome clicks using the inverse rate integral", async () => {
        const { clock, transport } = setup();
        await transport.start({ ...testTrack(), metronome: true });
        clock.currentTime = 10.40;
        transport.observe();
        const cancelled = clock.oscillators.find((node) => node.starts[0]![0] === 10.54)!;
        expect(cancelled).toBeDefined();
        expect(transport.beginSlowdown(1)).toBe(true);
        expect(cancelled.stops.at(-1)).toBeUndefined();
        expect(cancelled.connections).toBe(0);
        const duration = 2 * 0.64 / 1.12;
        const delta = 0.14;
        const deceleration = 0.88 / duration;
        const shifted = 10.40 + 2 * delta / (1 + Math.sqrt(1 - 2 * deceleration * delta));
        const replacement = clock.oscillators.at(-1)!;
        expect(replacement).not.toBe(cancelled);
        expect(replacement.starts[0]![0]).toBeCloseTo(shifted);
        expect(shifted).toBeGreaterThan(10.54);
        for (let step = 1; step <= 30; step++) {
            clock.currentTime = 10.40 + duration * step / 30;
            transport.observe();
        }
        // Beat zero and its tail are never replayed when the ramp begins.
        expect(clock.oscillators.filter((node) => node.starts[0]![0] === 10.04)).toHaveLength(1);
        expect(transport.position).toBe(1);
        transport.dispose();
    });

    test("slowdown works for bufferless dojo and preserves user volume independently", async () => {
        const { clock, transport } = setup();
        transport.setVolumes({ master: 0.3, music: 0.4, effects: 0.5 });
        await transport.start({ ...testTrack(), buffer: undefined, metronome: true });
        clock.currentTime = 10.14;
        transport.observe();
        expect(transport.beginSlowdown(0.5)).toBe(true);
        transport.setVolumes({ music: 0.7 });
        for (let step = 1; step <= 10; step++) {
            clock.currentTime = 10.14 + (2 * 0.4 / 1.12) * step / 10;
            transport.observe();
        }
        expect(clock.sources).toHaveLength(0);
        expect(transport.state).toBe("paused");
        expect(transport.musicGain.gain.value).toBe(0.7);
        expect(transport.effectsGain.gain.value).toBe(0.5);
        expect(transport.masterGain.gain.value).toBe(0.3);
        await transport.resume();
        expect(transport.musicGain.gain.value).toBe(0.7);
        expect(transport.transitionGain.gain.value).toBe(1);
        transport.dispose();
    });

    test("hidden, suspended, and stalled ramps freeze the last accepted playhead and clear automation", async () => {
        for (const reason of ["hidden", "suspended", "stall"] as const) {
            const { clock, transport } = setup();
            await transport.start(testTrack());
            clock.currentTime = 10.14;
            transport.observe();
            expect(transport.beginSlowdown(1)).toBe(true);
            clock.currentTime = 10.34;
            transport.observe();
            const accepted = transport.position;
            clock.currentTime = 11;
            if (reason === "hidden") transport.pause("hidden");
            if (reason === "suspended") clock.state = "suspended";
            const paused = transport.observe();
            expect(paused.pausedReason).toBe(reason);
            expect(paused.beats).toEqual([]);
            expect(transport.position).toBe(accepted);
            expect(transport.slowdownTarget).toBeUndefined();
            expect(transport.slowing).toBe(false);
            expect(transport.playbackRate).toBe(0);
            expect(clock.sources[0]!.connections).toBe(0);
            await transport.resume();
            expect(transport.playbackRate).toBe(1);
            expect(clock.sources[1]!.starts[0]![1]).toBe(accepted);
            transport.dispose();
        }
    });

    test("seek, restart and stop cannot retain a ramp or its old scheduled stop", async () => {
        for (const action of ["seek", "restart", "stop"] as const) {
            const { clock, transport } = setup();
            await transport.start(testTrack());
            clock.currentTime = 10.14;
            transport.observe();
            transport.beginSlowdown(1);
            if (action === "seek") transport.seek(2);
            else await transport[action]();
            expect(transport.slowing).toBe(false);
            expect(transport.slowdownProgress).toBe(0);
            expect(clock.sources[0]!.connections).toBe(0);
            expect(clock.sources[0]!.stops.at(-1)).toBeUndefined();
            expect(transport.position).toBe(action === "seek" ? 2 : 0);
            if (action !== "stop") expect(clock.sources.at(-1)!.playbackRate.value).toBe(1);
            transport.dispose();
        }
    });

    test("invalid boundaries and count-in are rejected; track completion wins at the audio end", async () => {
        const { clock, transport } = setup();
        expect(transport.beginSlowdown(1)).toBe(false);
        await transport.start({ ...testTrack(1), countInBeats: 1 });
        expect(transport.beginSlowdown(0.5)).toBe(false);
        clock.currentTime = 10.40;
        transport.observe();
        clock.currentTime = 10.64;
        transport.observe();
        for (const target of [NaN, Infinity, -1, 0, 2]) {
            expect(transport.beginSlowdown(target)).toBe(false);
        }
        expect(transport.beginSlowdown(1)).toBe(true);
        expect(transport.beginSlowdown(0.5)).toBe(false);
        const end = clock.currentTime + 2 * (1 - transport.position) / 1.12;
        let completed = 0;
        const start = clock.currentTime;
        for (let step = 1; step <= 20; step++) {
            clock.currentTime = start + (end - start) * step / 20;
            const observation = transport.observe();
            completed += Number(observation.completed);
            expect(observation.slowedToPause).toBeUndefined();
        }
        expect(completed).toBe(1);
        expect(transport.state).toBe("completed");
        expect(transport.position).toBe(1);
        expect(transport.observe().completed).toBe(false);
        transport.dispose();
    });

    test("does not emit beat zero before the scheduled audio start", async () => {
        const { clock, transport } = setup();
        await transport.start(testTrack());
        expect(clock.sources[0]!.starts[0]).toEqual([10.04, 0]);
        expect(transport.observe().beats).toEqual([]);
        clock.currentTime = 10.039;
        expect(transport.observe().beats).toEqual([]);
        clock.currentTime = 10.04;
        expect(transport.observe().beats.map((b) => [b.index, b.scheduledTime])).toEqual([[0, 10.04]]);
        expect(transport.observe().beats).toEqual([]);
        transport.dispose();
    });

    test("count-in is audible while combat starts at music zero", async () => {
        const { clock, transport } = setup();
        await transport.start({ ...testTrack(), countInBeats: 4 });
        expect(transport.position).toBe(-2);
        expect(clock.sources[0]!.starts[0]).toEqual([12.04, 0]);
        expect(clock.oscillators[0]!.starts[0]).toEqual([10.04]);
        let accepted: number[] = [];
        for (let n = 0; n <= 20; n++) {
            clock.currentTime = 10.04 + n / 10;
            accepted.push(...transport.observe().beats.map((b) => b.index));
            if (n < 20) expect(accepted).toEqual([]);
        }
        expect(accepted).toEqual([0]);
        transport.dispose();
    });

    test("pause freezes, resume recreates the source with its saved offset", async () => {
        const { clock, transport } = setup();
        await transport.start(testTrack());
        clock.currentTime = 10.29;
        expect(transport.observe().beats.map((b) => b.index)).toEqual([0]);
        transport.pause();
        expect(transport.position).toBeCloseTo(0.25);
        clock.currentTime = 50;
        expect(transport.position).toBeCloseTo(0.25);
        expect(transport.observe().beats).toEqual([]);
        expect(clock.sources[0]!.stopped).toBe(true);
        await transport.resume();
        expect(clock.sources[1]!.starts[0]![1]).toBeCloseTo(0.25);
        clock.currentTime = 50.30;
        expect(transport.observe().beats.map((b) => b.index)).toEqual([1]);
        transport.dispose();
    });

    test("immediate upgrade resume advances with audio immediately while ordinary resume retains its lead-in", async () => {
        const { clock, transport } = setup();
        await transport.start(testTrack());
        clock.currentTime = 10.29;
        transport.observe();
        transport.pause();
        const held = transport.position;
        clock.currentTime = 20;
        await transport.resume({ immediate: true });
        expect(clock.sources[1]!.starts[0]![0]).toBe(20);
        expect(clock.sources[1]!.starts[0]![1]).toBe(held);
        clock.currentTime = 20.01;
        expect(transport.position).toBeCloseTo(held + 0.01, 8);
        expect(transport.observe().beats).toEqual([]);
        transport.pause();
        const heldAgain = transport.position;
        clock.currentTime = 30;
        await transport.resume();
        expect(clock.sources[2]!.starts[0]![0]).toBe(30.04);
        clock.currentTime = 30.01;
        expect(transport.position).toBe(heldAgain);
        clock.currentTime = 30.05;
        expect(transport.position).toBeCloseTo(heldAgain + 0.01, 8);
        transport.dispose();
    });

    test("small frame gaps process all beats; long stalls pause without a backlog", async () => {
        const { clock, transport } = setup();
        await transport.start({ ...testTrack(), bpm: 300, beats: generateTimeline(4, 300) });
        clock.currentTime = 10.49;
        expect(transport.observe().beats.map((b) => b.index)).toEqual([0, 1, 2]);
        clock.currentTime = 12;
        const stalled = transport.observe();
        expect(stalled.pausedReason).toBe("stall");
        expect(stalled.beats).toEqual([]);
        expect(stalled.position).toBeCloseTo(0.45);
        await transport.resume();
        clock.currentTime = 12.04;
        expect(transport.observe().beats).toEqual([]);
        clock.currentTime = 12.20;
        expect(transport.observe().beats.map((b) => b.index)).toEqual([3]);
        transport.dispose();
    });

    test("suspension and tab hiding freeze at the last accepted command", async () => {
        const { clock, transport } = setup();
        await transport.start(testTrack());
        clock.currentTime = 10.14;
        transport.observe();
        clock.state = "suspended";
        expect(transport.observe().pausedReason).toBe("suspended");
        await transport.resume();
        clock.currentTime = 10.30;
        transport.pause("hidden");
        expect(transport.position).toBeCloseTo(0.1);
        expect(transport.observe().beats).toEqual([]);
        transport.dispose();
    });

    test("a delayed browser resume cannot resurrect a stopped or disposed source", async () => {
        for (const action of ["stop", "dispose"] as const) {
            const { clock, transport } = setup();
            await transport.start(testTrack());
            transport.pause();
            clock.state = "suspended";
            let allowAudio: (() => void) | undefined;
            clock.resume = () => new Promise<void>((resolve) => {
                allowAudio = () => { clock.state = "running"; resolve(); };
            });
            const resume = transport.resume();
            transport[action]();
            allowAudio!();
            await resume;
            expect(transport.state).toBe("stopped");
            expect(clock.sources.length).toBe(1);
            expect(clock.sources[0]!.stopped).toBe(true);
            transport.dispose();
        }
    });

    test("seek and restart clear old events; completion is delivered once", async () => {
        const { clock, transport } = setup();
        await transport.start(testTrack(1));
        clock.currentTime = 10.04;
        transport.observe();
        transport.seek(0.75);
        clock.currentTime = 10.35;
        const end = transport.observe();
        expect(end.beats).toEqual([]);
        expect(end.completed).toBe(true);
        expect(transport.observe().completed).toBe(false);
        expect(transport.state).toBe("completed");
        await transport.restart();
        clock.currentTime = 10.39;
        expect(transport.observe().beats.map((b) => b.index)).toEqual([0]);
        transport.dispose();
    });

    test("visual offset never changes accepted beats or audio scheduling", async () => {
        const { clock, transport } = setup();
        transport.setVisualOffset(200);
        transport.setVolumes({ master: 0.3, music: 0.4, effects: 0.5 });
        await transport.start(testTrack());
        clock.currentTime = 10.24;
        const observation = transport.observe();
        expect(observation.position).toBeCloseTo(0.2);
        expect(observation.visualPosition).toBeCloseTo(0.4);
        expect(observation.beats.map((b) => b.index)).toEqual([0]);
        expect(transport.masterGain.gain.value).toBe(0.3);
        expect(transport.musicGain.gain.value).toBe(0.4);
        expect(transport.effectsGain.gain.value).toBe(0.5);
        transport.dispose();
        expect(clock.gains.every((gain) => gain.connections === 0)).toBe(true);
    });

    test("calibration metronome follows imported first-beat offset", async () => {
        const { clock, transport } = setup();
        await transport.start({
            ...testTrack(),
            beats: generateTimeline(4, 120, 0.3),
            metronome: true,
        });
        expect(clock.oscillators).toHaveLength(0);
        clock.currentTime = 10.24;
        transport.observe();
        expect(clock.oscillators[0]!.starts[0]![0]).toBeCloseTo(10.34);
        transport.dispose();
    });

    test("a full track has no accumulated frame-time drift at different refresh rates", async () => {
        for (const fps of [30, 60, 144]) {
            const { clock, transport } = setup();
            await transport.start(testTrack(72));
            const accepted: number[] = [];
            let completions = 0;
            for (let frame = 0; frame <= Math.ceil(72.1 * fps); frame++) {
                clock.currentTime = 10.04 + frame / fps;
                const observation = transport.observe();
                accepted.push(...observation.beats.map((beat) => beat.index));
                completions += Number(observation.completed);
            }
            expect(accepted).toEqual(Array.from({ length: 144 }, (_, i) => i));
            expect(completions).toBe(1);
            expect(transport.position).toBe(72);
            transport.dispose();
        }
    });
});
