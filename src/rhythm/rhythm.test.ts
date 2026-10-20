import { describe, expect, test } from "bun:test";
import { beatAtPosition, BeatCursor, generateTimeline, validateTimeline } from "./timeline";
import { MusicTransport } from "./transport";

class FakeParam {
    value = 1;
    setValueAtTime(value: number) { this.value = value; }
    exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeNode {
    gain = new FakeParam();
    frequency = new FakeParam();
    buffer: AudioBuffer | null = null;
    type = "sine";
    onended: (() => void) | null = null;
    starts: number[][] = [];
    stopped = false;
    connections = 0;
    connect() { this.connections++; }
    disconnect() { this.connections = 0; }
    start(...args: number[]) { this.starts.push(args); }
    stop() { this.stopped = true; }
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
