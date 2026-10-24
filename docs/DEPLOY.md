# Openwhispr landing and beta distribution

The existing site remains on **ai-server**, `/srv/apps/openwhispr`, behind Traefik and the existing Cloudflare Tunnel. No infrastructure repository changes are needed.

## Landing

```sh
node landing/scripts/check.cjs
npx tsc -p landing/tsconfig.json
npm run landing:build
npm run landing:deploy
```

The deployment synchronizes the landing separately. It never deletes the sibling `releases/` directory. Nginx mounts `./releases` read-only, serves a real download (not an SPA fallback), and supports HEAD and range requests. `/releases/latest.json` is not cached.

## Current beta

```sh
npm run dist:mac
npm run release:publish
```

Build on Apple Silicon with the three native helpers already built and `.local/models/parakeet-tdt-0.6b-v3` present. The build compiles current source, bundles the speech model and runtime helpers, and removes personal name aliases from the packaged context. Development caches, source checkouts, meeting history and user settings are not included. The current beta is arm64, macOS 14.2+, version 0.1.3, without Apple notarization. Intel and Windows downloads are not advertised.

The publish script uploads via SSH to ai-server, verifies SHA-256 remotely, then atomically replaces the release manifest. `latest.json.previous` retains the prior manifest when there is one. Set a new package version before publishing a changed binary; do not overwrite an existing published version. The landing enables its buttons only after validating the manifest and checking that the artifact exists with the expected size and a non-HTML content type.

There is no automatic updater feed for this self-hosted beta. Packaged builds do not query the old placeholder GitHub repository. Future signed updates need a separately configured, verified update feed.

## Language

First visit: read `CF-IPCountry` through the same-origin `/locale.json`; if that edge header is absent, read only `loc` from Cloudflare's same-origin `/cdn-cgi/trace`. LATAM receives Spanish, other countries English. If the edge is unavailable, timezone is an approximate fallback. No external geolocation service or browser-location permission is used. The EN/ES switch overrides detection and is remembered in localStorage. VPNs affect the detected country.

The interactive preview is illustrative, can be paused/replayed, and never records audio. Reduced-motion preferences disable automatic playback.

## Verify production

```sh
curl -fsS https://openwhispr.rootoz.com/releases/latest.json
curl -I https://openwhispr.rootoz.com/releases/Openwhispr-0.1.3-arm64.dmg
```

Check that missing downloads return 404, not HTML with status 200. The current download is a beta without Apple notarization; the landing states this explicitly.

## Beta 0.1.2 correction

The app now includes its own icon and a verified ad-hoc signature for the Electron app, frameworks, native modules and audio helpers. The signing hook signs executable Mach-O code only; model weights and other resources are sealed without modification. The build and publisher both stop if strict codesign verification fails. This fixes the unsigned package but does not provide Developer ID or notarization. macOS may still require the user to authorize this specific beta through Privacy & Security → Open Anyway. System-wide security protections are not changed.

The landing preview recreates the translucent transcription and AI panels. It shows continuous text without speaker identification; its question response is an explicitly labelled simulation.

## Beta 0.1.3 renderer correction

Electron loads the UI from a local HTML file. Vite now uses relative asset paths, and `scripts/check-packaged-assets.mjs` rejects missing files or server-root references before packaging. The packaged application was opened to verify that its dashboard/setup interface actually renders.
