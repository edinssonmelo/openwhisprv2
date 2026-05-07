# MVP Scope

## Product Goal

Build a local-first desktop meeting assistant for macOS and Windows. The MVP must prove reliable audio capture before investing in summaries, advanced AI, calendar integrations, or polished meeting workflows.

The app captures microphone audio, system audio, or both; shows live diagnostics; records a local test WAV; transcribes in blocks; stores transcripts locally; answers simple questions from recent transcript text; and exports Markdown.

## Non-Negotiables

- No backend server in the MVP.
- No WebSocket in the MVP.
- No NestJS, FastAPI, or service daemon.
- No cloud provider by default.
- No diarization, stealth mode, overlay, calendar, Zoom, Meet, or bot integration.
- Audio reliability comes before AI features.

## Milestones

### 1. Audio Capture Reliability

The first usable screen is `Audio Diagnostics`.

It must show:

- Available microphones.
- Selected microphone.
- Microphone permission state.
- Screen/system audio permission state when applicable.
- Capture controls for mic, system, and both.
- RMS meters for mic, system, and mixed audio.
- Silence and clipping indicators.
- Detected sample rate.
- 30 second test recording.
- WAV save path.
- Playback of the recorded WAV.
- Clear failure state: permission, device, empty stream, zero RMS, or system error.

### 2. Block Transcription

After audio is stable:

- Convert captured audio to 16 kHz mono PCM.
- Send 2 to 5 second blocks to partial transcription.
- Send 15 to 30 second blocks to final transcription.
- Render partial and final segments in the UI.
- Persist final segments to SQLite.

### 3. Local Persistence

Use SQLite in the app data directory. Store meetings, transcript segments, and Q&A messages locally.

### 4. Ask Bar

Ask uses only already-transcribed text. For MVP, implement the `last 2 minutes` context mode first. If there is not enough transcript text, the answer must say so plainly.

Local Ollama can be added as an optional provider. OpenAI/OpenRouter can be optional later, never default.

### 5. Markdown Export

Export a `.md` file containing:

- Meeting title.
- Short summary placeholder or generated summary when available.
- Questions and answers.
- Full timestamped transcript.

## Reference Repos Used For Learning

### Meetily

Useful patterns:

- Treat recording and transcription as related but separate pipeline consumers.
- Keep local processing as the privacy baseline.
- Track audio health with live metrics instead of guessing.
- Platform-specific audio capture matters and must be explicit.

What not to copy:

- The larger Tauri/Rust architecture.
- Advanced VAD, ducking, diarization, and summarization before the audio MVP is proven.

### StenoAI

Useful patterns:

- Simple local recording and Markdown-first output.
- Clear macOS permission/fallback language for system audio.
- Keep system audio capture state visible to the user.
- Preserve display capture tracks carefully on macOS/Electron-style pipelines.

What not to copy:

- macOS-only product assumptions.
- Full CLI/process feature set.
- Diarized Markdown for the MVP.

### OpenWhispr

Useful patterns:

- Electron + React renderer can capture audio and emit small PCM chunks.
- `desktopCapturer` / `getDisplayMedia` / Chromium constraints are a practical first Electron route.
- Recent transcript context can power an assistant feature.

What not to copy:

- API server.
- Socket.IO/WebSocket flow.
- Cloud-first transcription assumptions.

## MVP Success Criteria

The MVP is successful only when:

- Windows captures microphone and system audio.
- macOS captures microphone and offers a functional, honest system-audio path.
- Mic and system RMS are displayed separately.
- Mixed RMS is displayed when both sources are active.
- A local WAV test recording is generated and sounds correct.
- Live block transcription is visible.
- Transcript segments are saved locally.
- The ask bar answers from recent transcript text only.

