# Audio Diagnostics Acceptance

## Manual Acceptance Checklist

### Microphone

- The microphone list is populated.
- The selected microphone can be changed.
- Microphone permission is shown as `granted`, `prompt`, `denied`, or `unknown`.
- Clicking `Capture mic` starts capture.
- Speaking raises the mic RMS meter.
- Stopping capture releases the microphone track.
- If permission is blocked, the UI says permission failed.
- If the device produces no samples, the UI says the stream is empty or RMS is zero.

### System Audio

- System/screen audio permission state is visible when the platform exposes it.
- Clicking `Capture system` starts the Electron display/system capture attempt.
- On Windows, playing YouTube/Spotify/Meet/Zoom raises the system RMS meter.
- On macOS, the Electron attempt is visible and failures are explicit.
- On macOS fallback, the UI clearly says:

  > Para capturar audio del sistema en este Mac, selecciona BlackHole como entrada del sistema o configura el módulo nativo en una fase posterior.

### Mixed Audio

- Clicking `Capture both` starts mic and system capture.
- Speaking raises mic RMS.
- Playing system audio raises system RMS.
- When both sources are active, mixed RMS rises.
- The UI distinguishes which source is silent.

### Silence and Clipping

- A quiet source shows a silence indicator after a short delay.
- Loud input near digital full scale shows a clipping indicator.
- Silence and clipping indicators are independent per source where possible.

### 30 Second WAV Test

- Clicking `Record test 30 seconds` starts a visible countdown.
- The button cannot start two simultaneous recordings.
- The resulting WAV is saved locally.
- The saved path is shown.
- Playback works from the UI.
- The WAV sounds correct for the selected mode.

### Failure Messages

The UI must classify failures as one of:

- `permission`
- `device`
- `empty-stream`
- `rms-zero`
- `system`

The failure message must tell the user what to try next.

## Final Hito 1 Acceptance

Hito 1 is complete only if:

- Speaking raises mic RMS.
- Playing system audio raises system RMS on Windows.
- macOS either captures system audio or clearly directs the user to the BlackHole fallback.
- Mixed RMS rises when both active sources are present.
- Test WAV playback confirms the actual captured audio.
- Failure states are user-visible and specific enough to debug.

