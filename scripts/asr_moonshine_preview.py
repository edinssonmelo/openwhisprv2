#!/usr/bin/env python3
"""Moonshine preview ASR wrapper.

Contract:
  python scripts/asr_moonshine_preview.py /path/to/audio.wav

Prints only transcript text to stdout. Diagnostics go to stderr.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path


DEFAULT_MODEL_NAME = "tiny-en"
DEFAULT_MODEL_ARCH = "tiny"
DEFAULT_TIMEOUT_SECONDS = 20


class TimeoutError(Exception):
    pass


def _timeout_handler(_signum: int, _frame: object) -> None:
    raise TimeoutError("Moonshine preview timed out")


def _load_moonshine_voice():
    try:
        from moonshine_voice import (  # type: ignore
            Transcriber,
            get_model_path,
            load_wav_file,
            string_to_model_arch,
        )

        return Transcriber, get_model_path, load_wav_file, string_to_model_arch
    except ImportError as exc:
        raise RuntimeError(
            "moonshine-voice is not installed. Install with: "
            "python -m pip install -r requirements-moonshine.txt"
        ) from exc


def _transcript_text(transcript: object) -> str:
    lines = getattr(transcript, "lines", None)
    if lines is None:
        return str(transcript).strip()
    return " ".join(
        str(getattr(line, "text", "")).strip()
        for line in lines
        if str(getattr(line, "text", "")).strip()
    ).strip()


def _resolve_model(get_model_path, string_to_model_arch) -> tuple[str, object]:
    model_path_override = os.environ.get("MOONSHINE_MODEL_PATH", "").strip()
    model_name = (
        os.environ.get("MOONSHINE_MODEL_NAME")
        or os.environ.get("MOONSHINE_MODEL")
        or DEFAULT_MODEL_NAME
    ).strip()
    model_arch_name = os.environ.get("MOONSHINE_MODEL_ARCH", DEFAULT_MODEL_ARCH).strip()

    model_path = (
        Path(model_path_override).expanduser().resolve()
        if model_path_override
        else get_model_path(model_name)
    )
    if not Path(model_path).exists():
        raise RuntimeError(
            f"Moonshine model path not found: {model_path}. "
            "Set MOONSHINE_MODEL_PATH or install a package with bundled models."
        )

    try:
        model_arch = string_to_model_arch(model_arch_name)
    except Exception as exc:
        raise RuntimeError(f"Invalid MOONSHINE_MODEL_ARCH={model_arch_name!r}") from exc

    return str(model_path), model_arch


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python scripts/asr_moonshine_preview.py /path/to/audio.wav", file=sys.stderr)
        return 2

    wav_path = Path(argv[1]).expanduser().resolve()
    if not wav_path.exists():
        print(f"Moonshine input WAV not found: {wav_path}", file=sys.stderr)
        return 2

    try:
        timeout_seconds = int(
            os.environ.get("MOONSHINE_PREVIEW_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
        )
    except ValueError:
        print("MOONSHINE_PREVIEW_TIMEOUT_SECONDS must be an integer", file=sys.stderr)
        return 2
    if timeout_seconds <= 0:
        print("MOONSHINE_PREVIEW_TIMEOUT_SECONDS must be greater than 0", file=sys.stderr)
        return 2

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(timeout_seconds)

    try:
        Transcriber, get_model_path, load_wav_file, string_to_model_arch = _load_moonshine_voice()
        model_path, model_arch = _resolve_model(get_model_path, string_to_model_arch)
        audio_data, sample_rate = load_wav_file(wav_path)
        with Transcriber(model_path=model_path, model_arch=model_arch) as transcriber:
            text = _transcript_text(
                transcriber.transcribe_without_streaming(audio_data, sample_rate)
            )
        if not text:
            print("Moonshine returned empty transcript", file=sys.stderr)
            return 1
        print(text)
        return 0
    except TimeoutError as exc:
        print(str(exc), file=sys.stderr)
        return 124
    except Exception as exc:
        print(f"Moonshine preview failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
