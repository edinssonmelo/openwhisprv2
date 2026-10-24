# Release checklist

## Validate a beta

- [ ] Bump package and lockfile versions; never reuse a published version for different bytes.
- [ ] Run `npm run typecheck`, `npm run build`, and `node scripts/check-packaged-assets.mjs`.
- [ ] Run `npm run test:asr` on Apple Silicon with the native helper and model installed.
- [ ] Build the native audio helpers and run `npm run dist:mac`.
- [ ] Mount the resulting DMG read-only and verify its embedded app with `codesign --verify --deep --strict`.
- [ ] Check the custom icon and packaged model, then open the packaged app and confirm the UI actually renders.
- [ ] Test microphone/system-audio capture and local persistence with synthetic or consented test audio.
- [ ] Keep signing claims accurate: ad-hoc integrity verification is not Developer ID or Apple notarization.
- [ ] Do not commit recordings, local databases, model weights, build caches or installers.

## Publish using the existing deployment

- [ ] Run `npm run release:publish` with authorized SSH access to ai-server.
- [ ] Check `https://openwhispr.rootoz.com/releases/latest.json` and the referenced download.
- [ ] Verify remote artifact size and SHA-256; missing downloads must return 404.
- [ ] Verify the landing enables its download buttons for the new version.
- [ ] For landing changes, run its checks/build and `npm run landing:deploy`.
- [ ] Confirm both languages, manual switching, preview controls and reduced-motion behavior.

Automatic updater distribution, Intel/Windows installers and Apple notarization require separate completed work before advertising them.
