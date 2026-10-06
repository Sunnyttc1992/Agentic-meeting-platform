#!/usr/bin/env python3
"""Offline-only pyannote Community-1 worker.

This program receives file paths from the Node server. It has no HTTP listener,
does not print transcript/audio data, and writes a bounded JSON turn list only.
The operator must supply an already-acquired local model directory.
"""

import argparse
import json
import os
from pathlib import Path

# Set before pyannote / Hugging Face imports. The host firewall remains the
# enforcement boundary; these settings ensure the worker never tries a model
# download or optional pyannote telemetry.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"


def parse_arguments():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def load_speech_wav(input_path):
    """Decode the server's validated 16-bit PCM mono 16 kHz WAV in memory.

    Passing a waveform instead of a path keeps pyannote from invoking its
    FFmpeg-backed decoder, so the worker runs no codec on meeting audio.
    """
    import wave

    import torch

    with wave.open(str(input_path), "rb") as reader:
        if (reader.getcomptype(), reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != ("NONE", 1, 2, 16000):
            raise RuntimeError("Audio must be 16-bit PCM, mono, 16 kHz")
        frames = reader.readframes(reader.getnframes())
    samples = torch.frombuffer(bytearray(frames), dtype=torch.int16).to(torch.float32) / 32768.0
    return {"waveform": samples.unsqueeze(0), "sample_rate": 16000}


def main():
    args = parse_arguments()
    model_path = Path(args.model).resolve(strict=True)
    input_path = Path(args.input).resolve(strict=True)
    output_path = Path(args.output).resolve()
    if not model_path.is_dir() or not input_path.is_file():
        raise RuntimeError("Model or input path is invalid")

    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(str(model_path))
    result = pipeline(load_speech_wav(input_path))
    # Community-1 exposes an exclusive track specifically for reconciling
    # diarization with transcription timestamps. Fall back only for an older
    # compatible result shape.
    annotation = getattr(result, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = getattr(result, "speaker_diarization", result)
    turns = []
    for turn, _, label in annotation.itertracks(yield_label=True):
        start_ms = max(0, round(float(turn.start) * 1000))
        end_ms = max(start_ms + 1, round(float(turn.end) * 1000))
        turns.append({"startMs": start_ms, "endMs": end_ms, "label": str(label)})

    # Atomic replacement makes a partial worker result impossible to parse.
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(json.dumps({"version": 1, "turns": turns}, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output_path)


if __name__ == "__main__":
    main()
