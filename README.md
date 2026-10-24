# Openwhispr

**[View the live demo → openwhispr.rootoz.com](https://openwhispr.rootoz.com/)**

A local-first meeting assistant for macOS. Capture microphone and system audio, follow a continuous transcript, save sessions locally, and use the AI companion when a local model is configured.

The website includes an animated preview of the translucent transcription and AI panels. **The browser demo is a simulation:** it does not record audio or call an AI model. It automatically selects Spanish for LATAM and English elsewhere, with a manual language switch.

## Current beta

- **Version:** 0.1.3, macOS 14.2+ on Apple Silicon (M1 or newer).
- **Download:** [Get the current beta](https://openwhispr.rootoz.com/#download). [Release metadata and SHA-256](https://openwhispr.rootoz.com/releases/latest.json).
- **Speech engine:** Parakeet TDT 0.6B v3 through FluidAudio / Core ML. The downloadable beta includes the model. Whisper Large V3 Turbo is an optional development fallback and requires separate setup.
- **Privacy:** meeting audio and transcripts stay on the device by default. Optional telemetry is opt-in. See [privacy](docs/PRIVACY.md).
- **Signing:** verified ad-hoc signature and a custom app icon; **not Apple-notarized**. macOS can require per-app authorization through Privacy & Security → Open Anyway. No system-wide security changes are required. [Apple’s guidance](https://support.apple.com/en-us/102445).
- Intel and Windows installers are not currently distributed here. Speaker identification is not part of the preview; transcription is shown as continuous text.

## Develop on an Apple Silicon Mac

Install Node.js 20+, Xcode Command Line Tools and git. Models, audio recordings and native build outputs are intentionally excluded from Git.

```sh
npm install
npm run asr:setup
npm run asr:check
npm run dev
```

For system-audio capture, build the native helpers once and grant macOS permissions when requested:

```sh
(cd tools/macos-system-audio-helper && swift build -c release)
(cd tools/macos-coreaudio-tap-helper && swift build -c release)
```

Optional Whisper fallback: install CMake, a C++ compiler and ffmpeg, then run `npm run whisper:setup:turbo` and `npm run whisper:check`. The local AI companion has separate model/configuration requirements; it is not the speech-recognition engine.

## Checks and desktop build

```sh
npm run typecheck
npm run build
node scripts/check-packaged-assets.mjs
npm run test:asr
npm run dist:mac
```

`dist:mac` builds the arm64 beta into `release/current/`. It bundles the local Parakeet model and the three native helpers, excludes personal name aliases and development caches, applies an ad-hoc signature, and verifies the app icon and code signature before creating the disk image. It requires the models and native helpers described above.

The production renderer uses relative asset paths so `file://` loading works in Electron. The packaged-asset check rejects server-root paths and missing files, preventing the blank-window packaging regression.

## Landing and distribution

```sh
npm run landing:dev
node landing/scripts/check.cjs
npx tsc -p landing/tsconfig.json
npm run landing:build
```

The existing deployment is hosted on ai-server behind Nginx, Traefik and Cloudflare Tunnel. It serves versioned installers and an uncached release manifest. Download buttons validate the manifest and the actual file before becoming active.

Maintainers with access to ai-server can use `npm run landing:deploy` and `npm run release:publish`. Publishing verifies the app signature and the transferred artifact before switching the current release. Automatic updates remain disabled until a verified update feed is configured.

See [deployment](docs/DEPLOY.md), [distribution](docs/DISTRIBUTION.md), [release checklist](docs/RELEASE_CHECKLIST.md), and [launch status](docs/LAUNCH.md).

GitHub Actions provides **manual source validation only**. Pushing this repository does not automatically publish installers or trigger a paid distribution workflow.

## License

MIT. See [LICENSE](LICENSE). The forest photograph used in the demo is credited in [landing assets](landing/public/ASSETS.md).
