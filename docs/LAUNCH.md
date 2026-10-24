# Launch status

Public demo: **https://openwhispr.rootoz.com/**

Current desktop beta: **0.1.3**, Apple Silicon, macOS 14.2+. Downloads are served by the existing ai-server deployment, not the former placeholder GitHub release feed. See [DEPLOY.md](DEPLOY.md) and [DISTRIBUTION.md](DISTRIBUTION.md).

The landing reproduces the translucent transcription panel, floating controls and AI companion, with an explicitly simulated animation. Spanish is selected for LATAM and English elsewhere; users can override it manually.

The beta includes the Parakeet speech model, native audio helpers, a custom icon and a verified ad-hoc signature. It has **not** been notarized by Apple. Per-app authorization can still be required by macOS. Developer ID signing and notarization remain future distribution work; they are not presented as complete.

Version 0.1.3 fixes the blank production window by using relative renderer assets for Electron file loading. Builds now check those references before packaging.

No Intel or Windows release is advertised. Automatic updates and automatic GitHub releases are disabled. The manual GitHub workflow validates source and builds the renderer and landing; it does not publish installers.
