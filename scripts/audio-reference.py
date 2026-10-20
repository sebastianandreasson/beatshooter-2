"""Compare browser beat output with official Beat This 1.1.0 on identical PCM.

Export PCM with `bun scripts/export-analysis-pcm.ts` against a dev server on4174.
Prepare an isolated Python3.12 environment with audio-reference-requirements.txt.
Run with that environment under output/audio-analysis/reference:
  output/audio-analysis/reference/.venv/bin/python scripts/audio-reference.py

Inputs are local track-N.f32 files exported by the browser's preprocessing,
not audio uploaded to a service. This measures implementation agreement,
not musical accuracy against human annotations.
"""
import hashlib
import importlib.metadata
import json
import platform
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torchaudio
from beat_this.inference import Audio2Beats

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/audio-analysis/reference"
OUT.mkdir(parents=True, exist_ok=True)
torch.hub.set_dir(str(OUT / "torch"))
torch.set_num_threads(4)


def compare(reference, browser, tolerance=0.07):
    left = right = 0
    errors = []
    while left < len(reference) and right < len(browser):
        delta = browser[right] - reference[left]
        if abs(delta) <= tolerance:
            errors.append(abs(delta) * 1000)
            left += 1
            right += 1
        elif delta < 0:
            right += 1
        else:
            left += 1
    precision = len(errors) / len(browser) if len(browser) else 0
    recall = len(errors) / len(reference) if len(reference) else 0
    return {
        "toleranceMilliseconds": tolerance * 1000,
        "referenceCount": len(reference),
        "browserCount": len(browser),
        "matched": len(errors),
        "agreementPrecision": precision,
        "agreementRecall": recall,
        "agreementF1": 2 * precision * recall / (precision + recall) if precision + recall else 0,
        "medianErrorMilliseconds": float(np.median(errors)) if errors else None,
        "p95ErrorMilliseconds": float(np.percentile(errors, 95)) if errors else None,
        "exactArrayMatch": list(reference) == list(browser),
    }


CHECKPOINT_BYTES = 81_058_141
CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
report = {"schemaVersion": 1, "complete": False, "results": []}
report_path = OUT / "report.json"

def save_report():
    report_path.write_text(json.dumps(report, indent=2) + "\n")

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def require(condition, message):
    if not condition:
        raise ValueError(message)

save_report()
try:
    manifest = json.loads((OUT / "pcm.json").read_text())
    require(isinstance(manifest, dict) and manifest.get("complete") is True,
            "Run the current PCM exporter first; a complete versioned manifest is required.")
    benchmark_path = OUT.parent / "report.json"
    require(digest(benchmark_path) == manifest["sourceReportSha256"],
            "Benchmark report changed; export PCM again.")
    benchmark = json.loads(benchmark_path.read_text())["results"]
    entries = manifest["tracks"]
    require(len(entries) == len(benchmark) - 1 and len(entries) > 0,
            "PCM manifest must contain every local benchmark track.")
    inputs = []
    for index, entry in enumerate(entries, 1):
        item = benchmark[index]
        require(entry["trackIndex"] == index and entry["file"] == item["file"], "Track identity mismatch.")
        require(entry["path"] == f"output/audio-analysis/reference/track-{index}.f32", "Unexpected PCM path.")
        pcm_path = OUT / f"track-{index}.f32"
        analysis_path = OUT.parent / f"track-{index}-beats.json"
        require(pcm_path.is_file() and analysis_path.is_file(), f"Missing input for {entry['file']}.")
        require(digest(pcm_path) == entry["pcmSha256"] and
                digest(analysis_path) == entry["browserAnalysisSha256"], "PCM or browser timing data changed.")
        require(item["chartId"].startswith("analyzed-" + entry["sourceSha256"] + "-"), "Source identity mismatch.")
        require(entry["sampleRate"] == 22050 and pcm_path.stat().st_size == entry["sampleCount"] * 4,
                "Invalid PCM sample count or rate.")
        browser = json.loads(analysis_path.read_text())
        require(len(browser["beats"]) == item["beatCount"] and
                len(browser["downbeats"]) == item["downbeatCount"] and
                abs(browser["duration"] - item["durationSeconds"]) <= 0.002 and
                abs(entry["duration"] - browser["duration"]) <= 0.002 and
                abs(entry["sampleCount"] / 22050 - entry["duration"]) <= 1 / 22050,
                "Track duration/count does not match the benchmark.")
        inputs.append((entry, pcm_path, browser))

    checkpoint = OUT / "torch/checkpoints/beat_this-final0.ckpt"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if not checkpoint.exists():
        temporary = checkpoint.with_suffix(".partial")
        try:
            urllib.request.urlretrieve("https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt", temporary)
            require(temporary.stat().st_size == CHECKPOINT_BYTES and digest(temporary) == CHECKPOINT_SHA256,
                    "Downloaded checkpoint does not match the pinned final0 weights.")
            temporary.replace(checkpoint)
        finally:
            temporary.unlink(missing_ok=True)
    require(checkpoint.stat().st_size == CHECKPOINT_BYTES and digest(checkpoint) == CHECKPOINT_SHA256,
            "Checkpoint does not match the pinned final0 weights.")
    print("Loading checksum-verified official Beat This 1.1.0 final0 on CPU...", flush=True)
    tracker = Audio2Beats(checkpoint_path=str(checkpoint), device="cpu", float16=False, dbn=False)
    report.update({
        "recordedAt": datetime.now(timezone.utc).isoformat(), "python": sys.version,
        "platform": platform.platform(), "torch": torch.__version__, "torchaudio": torchaudio.__version__,
        "beatThis": importlib.metadata.version("beat-this"), "numpy": np.__version__,
        "device": "cpu", "threads": torch.get_num_threads(), "checkpoint": "final0",
        "checkpointBytes": CHECKPOINT_BYTES, "checkpointSha256": CHECKPOINT_SHA256,
        "postprocessor": "minimal (no DBN)", "upstream": "https://github.com/CPJKU/beat_this/tree/v1.1.0",
        "sourceReportSha256": manifest["sourceReportSha256"],
        "comparison": "Same browser-preprocessed 22050 Hz mono PCM; official CPU vs browser WebGPU. Agreement is not human musical accuracy.",
    })
    for entry, pcm_path, browser in inputs:
        pcm = np.fromfile(pcm_path, dtype="<f4")
        require(np.isfinite(pcm).all(), "PCM contains invalid samples.")
        start = time.perf_counter()
        beats, downbeats = tracker(pcm, 22050)
        elapsed = time.perf_counter() - start
        reference = {"beats": beats.tolist(), "downbeats": downbeats.tolist()}
        index = entry["trackIndex"]
        (OUT / f"track-{index}-official.json").write_text(json.dumps(reference, indent=2) + "\n")
        result = {
            "trackIndex": index, "file": entry["file"], "samples": len(pcm),
            "durationSeconds": len(pcm) / 22050, "pcmSha256": entry["pcmSha256"],
            "elapsedSeconds": elapsed,
            "beats": compare(reference["beats"], browser["beats"]),
            "downbeats": compare(reference["downbeats"], browser["downbeats"]),
        }
        report["results"].append(result)
        save_report()
        print(json.dumps(result), flush=True)
    report["complete"] = True
    save_report()
except Exception as error:
    report["error"] = str(error)
    save_report()
    raise
