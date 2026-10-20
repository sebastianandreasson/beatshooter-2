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
BEATS_PER_BAR = 4
BAR_SECONDS = BEATS_PER_BAR * 60 / BPM
# One arrangement drives both the sound and the game's section boundaries.
SECTIONS = [
    ("intro", 0, 4),
    ("verse", 4, 12),
    ("chorus", 12, 20),
    ("bridge", 20, 24),
    ("chorus", 24, 32),
    ("outro", 32, 36),
]
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


# 36 bars: sparse opening, rhythmic verse, full chorus, half-time bridge,
# returning chorus, and a stripped-back ending. Every section starts on a bar.
chords = [(48, 51, 55), (44, 48, 51), (51, 55, 58), (46, 50, 53)]
for beat in range(DURATION * BPM // 60):
    time = beat * 60 / BPM
    bar = beat // BEATS_PER_BAR
    label, first_bar, _ = next(section for section in SECTIONS if section[1] <= bar < section[2])
    full = label == "chorus"
    sparse = label in ("intro", "bridge", "outro")
    chord = chords[bar % len(chords)]
    # All beat timestamps correspond to the start of an audible kick.
    kick = 0.44 if full else 0.27 if sparse else 0.36
    add(time, 0.26, lambda t, n: kick * math.sin(tau * (47 * t + 9 * (1 - math.exp(-25 * t)))) * math.exp(-20 * t))
    if (not sparse and beat % 2) or (label == "bridge" and beat % 4 == 2):
        # New deterministic noise, generated directly, not sampled.
        snare = 0.18 if full else 0.11
        add(time, 0.14, lambda t, n: snare * rng.uniform(-1, 1) * math.exp(-35 * t))
    hats = (0, 0.125, 0.25, 0.375) if full else (0, 0.25) if label == "verse" else (0.25,)
    for offset in hats:
        hat = 0.046 if full else 0.032 if label == "verse" else 0.018
        add(time + offset, 0.065, lambda t, n: hat * rng.uniform(-1, 1) * math.exp(-65 * t))
    bass = chord[0] - 12 + (12 if beat % 4 == 3 else 0)
    bass_gain = 0.24 if full else 0.19 if label == "verse" else 0.12
    if label != "bridge" or beat % 2 == 0:
        add(time, 0.42, lambda t, n, note=bass: bass_gain * synth(note, t, 0.15, not sparse))
    if beat % 4 == 0:
        pad_gain = 0.075 if full else 0.065 if label == "bridge" else 0.045
        add(time, 1.8, lambda t, n, notes=chord: pad_gain * sum(synth(note + 12, t, 0.7) for note in notes))
    if label in ("verse", "chorus") or (label == "outro" and bar < first_bar + 2):
        for half in (0, 0.25):
            note = chord[(beat * 2 + (1 if half else 0)) % 3] + 24
            arp_gain = 0.10 if full else 0.06 if label == "verse" else 0.035
            add(time + half, 0.23, lambda t, n, note=note: arp_gain * synth(note, t, 0.075, True))
    if full and beat % 2 == 0:
        note = chord[(bar + beat) % 3] + 24
        add(time, 0.8, lambda t, n, note=note: 0.12 * synth(note, t, 0.3, True))
    if bar == first_bar and beat % 4 == 0 and label in ("chorus", "bridge"):
        # A short synthesized cymbal marks the major arrangement changes.
        add(time, 0.75, lambda t, n: 0.08 * rng.uniform(-1, 1) * math.exp(-7 * t))

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
    "beatsPerBar": BEATS_PER_BAR,
    "source": "Original deterministic synthesizer composed for Beatshooter 2; source: src/tracks/generate-demo.py",
    "license": "CC0-1.0",
    "structure": {
        "version": 1,
        "analyzerVersion": "neon-circuit-arrangement-v1",
        "duration": DURATION,
        "elapsedMs": 0,
        "backend": "authored",
        "sections": [
            {"start": start * BAR_SECONDS, "end": end * BAR_SECONDS, "label": label}
            for label, start, end in SECTIONS
        ],
    },
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
