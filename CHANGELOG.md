# Changelog

## 0.1.3 — Current beta

- Fix blank packaged windows by loading renderer assets relative to the local HTML file.
- Reject missing or server-root renderer asset references before packaging.
- Verify the packaged application opens and displays its dashboard/setup interface.

## 0.1.2

- Add a custom macOS icon and verify ad-hoc code signatures for the app and native components.
- Stop publication when app-signature verification fails.
- Recreate the translucent transcription and AI panels in the bilingual website demo, with continuous text and no speaker attribution.
- Document the remaining Apple notarization limitation and per-app authorization.

## 0.1.1

- Serve versioned Apple Silicon beta downloads from ai-server, with a size/SHA-256 manifest.
- Bundle the local Parakeet speech model and native audio helpers without personal context or development caches.
- Add country-based Spanish/English selection, manual language switching and validated download links.
- Disable the placeholder automatic-update feed.

## Repository consolidation

- Include the current local transcription coordinator, native speech helper, local session persistence, AI companion and interface work.
- Feature the public demo at https://openwhispr.rootoz.com/ in the README and repository website.
- Keep generated native caches, installers, model weights, recordings and runtime databases out of Git.
- Replace the obsolete automatic installer-release workflow with manual source validation.
