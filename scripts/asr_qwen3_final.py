#!/usr/bin/env python3
"""Qwen3-ASR final ASR wrapper.

Contract:
  python scripts/asr_qwen3_final.py /path/to/audio.wav

Prints only transcript text to stdout. Diagnostics go to stderr.
"""

from __future__ import annotations

import contextlib
import io
import os
import signal
import sys
import tempfile
from pathlib import Path


DEFAULT_MODEL = ".local/qwen-asr/Qwen3-ASR-1.7B-8bit"
DEFAULT_LANGUAGE = "Spanish"
DEFAULT_TIMEOUT_SECONDS = 180


class TimeoutError(Exception):
    pass


def _timeout_handler(_signum: int, _frame: object) -> None:
    raise TimeoutError("Qwen3-ASR final timed out")


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (_project_root() / path).resolve()


def _normalize_text(text: object) -> str:
    return str(text).replace("\n", " ").strip()


def _load_mlx_audio():
    try:
        from mlx_audio.stt.generate import generate_transcription  # type: ignore

        return generate_transcription
    except ImportError as exc:
        raise RuntimeError(
            "mlx-audio is not installed. Expected environment: "
            ".venv-qwen-asr/bin/python with mlx-audio available."
        ) from exc


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python scripts/asr_qwen3_final.py /path/to/audio.wav", file=sys.stderr)
        return 2

    wav_path = Path(argv[1]).expanduser().resolve()
    if not wav_path.exists():
        print(f"Qwen input WAV not found: {wav_path}", file=sys.stderr)
        return 2

    model_path = _resolve_path(os.environ.get("QWEN3_ASR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL)
    if not model_path.exists():
        print(f"Qwen model path not found: {model_path}", file=sys.stderr)
        return 2

    language = os.environ.get("QWEN3_ASR_LANGUAGE", DEFAULT_LANGUAGE).strip() or DEFAULT_LANGUAGE
    try:
        timeout_seconds = int(os.environ.get("QWEN3_ASR_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    except ValueError:
        print("QWEN3_ASR_TIMEOUT_SECONDS must be an integer", file=sys.stderr)
        return 2
    if timeout_seconds <= 0:
        print("QWEN3_ASR_TIMEOUT_SECONDS must be greater than 0", file=sys.stderr)
        return 2

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(timeout_seconds)

    try:
        generate_transcription = _load_mlx_audio()
        package_stdout = io.StringIO()
        with tempfile.TemporaryDirectory(prefix="openwhispr-qwen-") as tmp_dir:
            output_base = str(Path(tmp_dir) / "transcript")
            with contextlib.redirect_stdout(package_stdout):
                result = generate_transcription(
                    model=str(model_path),
                    audio=str(wav_path),
                    output_path=output_base,
                    format="txt",
                    verbose=False,
                    language=language,
                )

            text = _normalize_text(getattr(result, "text", ""))
            if not text:
                output_text_path = Path(f"{output_base}.txt")
                if output_text_path.exists():
                    text = _normalize_text(output_text_path.read_text(encoding="utf-8"))

        if not text:
            print("Qwen3-ASR returned empty transcript", file=sys.stderr)
            return 1

        print(text)
        return 0
    except TimeoutError as exc:
        print(str(exc), file=sys.stderr)
        return 124
    except Exception as exc:
        print(f"Qwen3-ASR failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
