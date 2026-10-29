# Ghost Layers

Local-first WebXR / PWA prototype for spatial markers.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open the HTTPS deployment or the local Vite URL in a supported browser. Geolocation, device orientation and camera access require a secure context (localhost is accepted for local development). Build with `npm run build`.

## Included

- Three.js WebXR immersive AR entry point with hit-test and optional anchor support.
- Animated cyan shader grid, hit-test reticle and content placement.
- Mobile camera overlay, geolocation + compass proximity fallback.
- Local marker creation, browser-local storage, JSON import/export.
- PWA manifest and same-origin offline shell cache.

## Important platform limitations

- Browser WebXR immersive AR and passthrough availability depend on browser/device support and user permissions. Meta Quest Browser must expose `immersive-ar`; this cannot be enabled by website code alone.
- A WebXR hit-test provides a detected point and pose, not a full wall mesh. The grid is a visualizer around the hit pose, not reconstructed surface geometry.
- The mobile fallback is a camera/GPS/compass overlay. It cannot perform true wall detection, persistent world tracking or cross-device spatial anchoring.
- WebXR anchors are optional and browser-dependent. This prototype uses them when `XRHitTestResult.createAnchor()` is available and falls back to the hit pose otherwise.
- GPS proximity is approximate and generally cannot provide reliable 3–5 m indoor positioning.
- Marker metadata is local to this browser. JSON exports do not bundle local media files; media selected in the creation UI is available for the current session only. This is not a decentralized shared marketplace.
- The example premium listing is demonstration data only. No payments, bids, wallet signing or owner verification are implemented.
- 72 FPS is a performance target, not a guarantee. Validate on target Quest hardware and its browser.

## Data

`data/layers.json` contains an example marker using the requested schema. New locally placed markers are exported in the same general structure. Use HTTPS for real-device testing.
