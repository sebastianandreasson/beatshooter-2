"""Regenerate original CC0 Beatshooter 2 audio and authored manifest.

Only Python's standard library is needed: python3 src/tracks/generate-demo.py
No samples, external compositions, or assets are used.
"""
import array
import json
import math
from pathlib import Path
import random
import wave

RATE = 22050
DURATION = 72
BPM = 120
OUTPUT = Path(__file__).resolve().parents[2] / "public" / "tracks"
audio = array.array("f", [0]) * (RATE * DURATION)
rng = random.Random(20261020)
tau = math.tau


def add(start, duration, sample):
    first = round(start * RATE)
    length = min(round(duration * RATE), len(audio) - first)
    for n in range(max(0, length)):
        t = n / RATE
        audio[first + n] += sample(t, n)


def frequency(note):
    return 440 * 2 ** ((note - 69) / 12)


def synth(note, t, decay, bright=False):
    f = frequency(note)
    attack = min(1, t / 0.004)
    wave_value = math.sin(tau * f * t)
    if bright:
        wave_value += 0.28 * math.sin(tau * f * 2 * t)
        wave_value += 0.1 * math.sin(tau * f * 3 * t)
    return wave_value * attack * math.exp(-t / decay)


# 36 bars. A four-bar harmonic cycle develops over three twelve-bar sections.
chords = [(48, 51, 55), (44, 48, 51), (51, 55, 58), (46, 50, 53)]
for beat in range(DURATION * BPM // 60):
    time = beat * 60 / BPM
    bar = beat // 4
    chord = chords[bar % len(chords)]
    # All beat timestamps correspond to the start of an audible kick.
    add(time, 0.26, lambda t, n: 0.40 * math.sin(tau * (47 * t + 9 * (1 - math.exp(-25 * t)))) * math.exp(-20 * t))
    if beat % 2:
        # New deterministic noise, generated directly, not sampled.
        add(time, 0.14, lambda t, n: 0.14 * rng.uniform(-1, 1) * math.exp(-35 * t))
    for half in (0, 0.25):
        add(time + half, 0.065, lambda t, n: 0.042 * rng.uniform(-1, 1) * math.exp(-65 * t))
    bass = chord[0] - 12 + (12 if beat % 4 == 3 else 0)
    add(time, 0.42, lambda t, n, note=bass: 0.21 * synth(note, t, 0.15, True))
    if beat % 4 == 0:
        add(time, 1.8, lambda t, n, notes=chord: 0.055 * sum(synth(note + 12, t, 0.7) for note in notes))
    if bar >= 4:
        for half in (0, 0.25):
            note = chord[(beat * 2 + (1 if half else 0)) % 3] + 24
            add(time + half, 0.23, lambda t, n, note=note: 0.085 * synth(note, t, 0.075, True))
    if 12 <= bar < 32 and beat % 2 == 0:
        note = chord[(bar + beat) % 3] + 24
        add(time, 0.8, lambda t, n, note=note: 0.09 * synth(note, t, 0.3))

# Soft saturation and an end fade keep the small mono demo comfortable.
pcm = array.array("h")
for n, value in enumerate(audio):
    tail = min(1, (len(audio) - n) / (RATE * 0.25))
    pcm.append(round(math.tanh(value * 1.3) * 24575 * tail))
if __import__("sys").byteorder != "little":
    pcm.byteswap()
OUTPUT.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUTPUT / "neon-circuit.wav"), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(RATE)
    output.writeframes(pcm.tobytes())

manifest = {
    "schemaVersion": 1,
    "id": "neon-circuit",
    "title": "Neon Circuit",
    "artist": "Beatshooter 2 · original synthesis",
    "audioUrl": "./tracks/neon-circuit.wav",
    "artwork": "./tracks/neon-circuit.svg",
    "duration": DURATION,
    "bpm": BPM,
    "firstBeatOffset": 0,
    "beatsPerBar": 4,
    "source": "Original deterministic synthesizer composed for Beatshooter 2; source: src/tracks/generate-demo.py",
    "license": "CC0-1.0",
    "beats": [
        {
            "time": beat * 60 / BPM,
            "index": beat,
            "bar": beat // 4,
            "beatInBar": beat % 4,
            "downbeat": beat % 4 == 0,
        }
        for beat in range(DURATION * BPM // 60)
    ],
}
(OUTPUT / "neon-circuit.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Generated {OUTPUT / 'neon-circuit.wav'} ({len(pcm) * 2:,} PCM bytes).")
