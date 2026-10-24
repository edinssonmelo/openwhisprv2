#!/usr/bin/env python3
"""Persistent Nemotron MLX preview worker using newline-delimited JSON.

The model is loaded once. Each request transcribes a short rolling WAV window:
  {"id":"...", "audioPath":"/tmp/window.wav", "language":"en"}

Responses are emitted on stdout; diagnostics stay on stderr.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit"
LANGUAGE_KEYS = {"en": "en-US", "es": "es-ES", "auto": None}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_text(value: object) -> str:
    return " ".join(str(value or "").split())


def main() -> int:
    model_name = os.environ.get("NEMOTRON_ASR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL

    try:
        from mlx_audio.stt import load  # type: ignore

        model = load(model_name)
        # 3 right-context frames is the balanced low-latency profile (~320 ms).
        if hasattr(model, "default_att_context_size"):
            model.default_att_context_size = [56, 3]
    except Exception as exc:
        emit({"type": "fatal", "error": f"Could not load Nemotron: {exc}"})
        traceback.print_exc(file=sys.stderr)
        return 1

    emit({"type": "ready", "model": model_name})
    if "--check" in sys.argv:
        return 0

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = "unknown"
        started = time.monotonic()
        try:
            request = json.loads(line)
            request_id = str(request.get("id", "unknown"))
            if request.get("type") == "stop":
                return 0

            audio_path = Path(str(request["audioPath"])).expanduser().resolve()
            if not audio_path.exists():
                raise FileNotFoundError(f"Audio file not found: {audio_path}")

            requested_language = str(request.get("language", "auto"))
            language = LANGUAGE_KEYS.get(requested_language)
            text = ""

            # stream_generate uses Nemotron's cache-aware streaming path internally.
            # The Electron side sends short rolling windows and this process keeps
            # model weights resident, avoiding model startup on every preview.
            stream_generate = getattr(model, "stream_generate", None)
            if callable(stream_generate):
                for result in stream_generate(str(audio_path), language=language):
                    candidate = normalize_text(getattr(result, "text", ""))
                    if candidate:
                        text = candidate
            else:
                result = model.generate(
                    str(audio_path),
                    language=language,
                    att_context_size=[56, 3],
                )
                text = normalize_text(getattr(result, "text", ""))

            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "text": text,
                    "durationMs": round((time.monotonic() - started) * 1000),
                    "model": model_name,
                }
            )
        except Exception as exc:
            emit(
                {
                    "type": "error",
                    "id": request_id,
                    "error": str(exc),
                    "durationMs": round((time.monotonic() - started) * 1000),
                }
            )
            traceback.print_exc(file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
