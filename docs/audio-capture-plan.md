# Audio Capture Plan

## Principle

The first milestone is an audio diagnostic instrument. It is not a meeting UX yet. The app should make audio failures obvious and actionable.

## Capture Strategy

### Microphone

Use `navigator.mediaDevices.getUserMedia({ audio })` from the Electron renderer.

Required behavior:

- List all `audioinput` devices.
- Allow selecting a mic by `deviceId`.
- Show permission state via the Permissions API when available.
- If permission is denied, show a permission-specific failure.
- If a stream is created but RMS remains zero, show `RMS cero / stream silencioso`.

### System Audio on Windows

Use the simplest Electron route first:

- Request display/system audio from Chromium/Electron constraints.
- Use `desktopCapturer.getSources()` in Main to provide selectable desktop sources when needed.
- In Renderer, request the desktop source with Electron `chromeMediaSource` constraints.

Acceptance target:

- YouTube/Spotify/Meet/Zoom playback raises the system RMS meter.
- The test WAV contains the expected system audio when recording system or mixed mode.

If Chromium constraints are insufficient on a target Windows build, add a native WASAPI loopback module later. That is outside the first pass unless diagnostics prove it is necessary.

### System Audio on macOS

Try Electron display capture first:

- Request display capture with audio.
- Keep the display video track alive for the capture lifetime, even if it is hidden or disabled.
- Surface screen/system audio permission state clearly.

If Electron display capture does not provide reliable system audio on the current Mac, use an explicit BlackHole fallback:

> Para capturar audio del sistema en este Mac, selecciona BlackHole como entrada del sistema o configura el módulo nativo en una fase posterior.

MVP does not implement a Swift/ScreenCaptureKit native module unless the Electron route and BlackHole fallback both fail the acceptance criteria.

## Diagnostics State Machine

Each source has an independent state:

- `idle`
- `requesting_permission`
- `capturing`
- `stream_empty`
- `rms_zero`
- `silence`
- `clipping`
- `failed`
- `stopped`

Failures should include:

- category: `permission | device | empty-stream | rms-zero | system`
- message for users
- technical detail for debugging

## Metering

Compute RMS with Web Audio:

- Use an `AnalyserNode` or processor node for each source.
- RMS is computed from time-domain float samples.
- Silence threshold starts at `0.01`.
- Clipping threshold starts when sample absolute value is at or above `0.98`.
- Mixed RMS is computed from the mixed graph, not by simply averaging displayed mic/system values.

Initial UI units:

- RMS as `0.000` to `1.000`.
- Meter bar as percentage.
- Silence shown when RMS stays below threshold for a short window.
- Clipping shown immediately, with a short decay so the user sees it.

## Test WAV Recording

The `Record test 30 seconds` button records the selected capture mode:

- mic
- system
- both/mixed

For the MVP, the WAV can be produced in the renderer from Float32 PCM and saved through Main IPC.

Recording requirements:

- Prefer 48 kHz when the AudioContext uses it.
- Write 16-bit PCM WAV.
- Save into an app-local `recordings/` directory.
- Display the saved path.
- Provide playback in the UI through a local file URL returned by Main.

## Implementation Order

1. Scaffold Electron + React + TypeScript.
2. Build `Audio Diagnostics` shell.
3. List microphones and select one.
4. Capture mic and show RMS.
5. Capture system audio on Windows/Electron path.
6. Capture/fallback system audio on macOS.
7. Add mixed graph and mixed RMS.
8. Add 30 second WAV recorder.
9. Add clear failure taxonomy.
10. Add SQLite only after capture diagnostics behave.

## Known Risks

- Electron system audio behavior differs by OS, Electron version, permission state, and source type.
- macOS may require Screen & System Audio Recording permission and still need BlackHole for reliable loopback.
- Bluetooth devices can report unexpected sample rates or introduce resampling artifacts.
- Stopping display video tracks too early can break system audio capture on macOS.
- `ScriptProcessorNode` is deprecated but still useful for MVP diagnostics; move to `AudioWorklet` after the audio path is proven.

