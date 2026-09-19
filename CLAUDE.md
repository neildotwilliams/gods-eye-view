# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

God's Eye View is a browser app that shows a CesiumJS 3D globe with live public
data (aircraft, ships, satellites, earthquakes, CCTV, traffic, launches, radio)
and voice control through the OpenAI Realtime API. It uses vanilla JavaScript ES
modules with Cesium and Vite, and has no UI framework. The Vite dev server also
acts as the backend: provider proxies run as Vite middleware.

This checkout is a clone of the fork `neildotwilliams/gods-eye-view`. Upstream
is `bilawalsidhu/gods-eye-view`, which the README and `package.json` point to.

## Local environment (this laptop)

- **Node:** the project requires `>=24.14 <25` or `26.x`, but the system Node is
  20. A user-space Node 24 lives at `~/.local/opt/node-v24.21.0-linux-x64/`.
  Prefix commands with
  `PATH=~/.local/opt/node-v24.21.0-linux-x64/bin:$PATH`, or bare
  `node`/`npm` will run Node 20 and fail the engine check.
- **`./start.sh`** is a local addition, not an upstream file. It selects Node 24,
  runs `sfw npm ci` if `node_modules` is missing, refuses to start if the port
  is already in use, then runs `npm run dev`. `HOST`/`PORT` and extra Vite
  arguments pass through.
- Installs always go through `sfw` (`sfw npm ci`). npm leaves the
  esbuild and puppeteer postinstall scripts unapproved. esbuild works without its
  script. Puppeteer only matters for the QA harnesses, which find Chrome
  in `~/.cache/puppeteer` or a system install.
- **Wingbits (Home) layer (fork addition):** `.env` sets `GEV_LOCAL_READSB_URL`
  to the `wingbits` Pi's feed (`http://192.168.0.132/tar1090/data/aircraft.json`;
  see `~/Projects/Wingbits/CLAUDE.md`). `server/providers/aircraft/local-receiver.js`
  serves it at `/api/home-receiver`; `src/data/homeReceiverLayer.js` is the
  lightweight Data Layers row (Wingbits orange, `src/data/homeReceiver.js`), and
  `flights.js` hides duplicates while it is on (same pattern as the Military
  layer). Adding a layer means a `LAYER_STATE_REGISTRY` entry too, or
  `finalizeRegistrations` throws at startup. Wingbits on with Live Flights off
  is the light setup for this low-powered laptop. The feature only reads from
  the Pi, so it can't disturb the feeder. Contacts are dead-reckoned once a
  second between 3 s polls (`homeReceiverDeadReckon`) via one
  `governorRequestRender` per tick, never a continuous render hold. Clicking a
  contact (its own `ScreenSpaceEventHandler` + `pickRegistry.js` ownership,
  like every other clickable layer) opens `src/wingbitsContactPanel.js`, a
  details box modelled on the CCTV viewer's popup that injects its own DOM/CSS
  on first use (no index.html/ui.js changes) rather than joining the
  panel-stack layout system. It positions itself at the click
  (`wingbitsContactPosition`, clamped on-screen) rather than a fixed corner,
  to stay clear of the app's own panels. Icon size follows aircraft class via
  Live Flights' shared `CLASS_SCALE_2D` table (`homeReceiverIconScale`).
- `build/` contains hand-written source (`build/vite.js`), not build output.
  `~/Projects/.stignore` has a `!GodsEyeView/build` exception for this. `dist/`
  is the real build output and is excluded from sync.

## Commands

```bash
./start.sh                 # dev server → http://localhost:4173 (localhost-only)
npm run doctor             # setup check: Node version, deps, which providers are configured
npm test                   # all unit tests (~8 min; allocation benchmarks dominate)
node --test src/foo.test.mjs                     # one test file
node --test --test-name-pattern='name' src/foo.test.mjs   # one test
npm run build              # production bundle → dist/
npm run format             # Prettier, only on files listed in scripts/format-scope.json
npm run format:check
npm run check:boundaries   # builds each package export, rejects undeclared imports
npm run test:track         # tracking regression in headless Chromium; needs the dev server already running
```

- Tests use `node:test` in files named `src/**/*.test.mjs`, placed next to the
  code they test. `scripts/run-unit-tests.mjs` discovers them, runs them in
  parallel, then runs two GC-bracketed allocation benchmarks
  (`src/data/focusAllocations.test.mjs` and
  `src/overlays/worldOverlayAllocation.test.mjs`) serially with `--expose-gc`.
  Those budgets are calibrated for Node 24; on other Node versions they are
  skipped unless `GEV_REQUIRE_ALLOCATION_GATE=1`. To run one directly:
  `node --expose-gc --test --test-concurrency=1 <file>`.
- Many tests read the source text and assert its structure, so moving
  or rewrapping code can break a test without changing behavior. Preserve
  what the test covers rather than deleting the assertion.
- CI (`.github/workflows/ci.yml`) runs doctor, format:check, check:boundaries,
  test and build on Node 24.14.0 and 26.x, plus a Windows Pinokio install job.
  CONTRIBUTING asks for `build`, `test` and `test:track` to pass before a PR.
  On this laptop, `test:track` fails 7 checks on unmodified upstream code as
  well (101 pass). They are the `ground-3d` frame-window timeouts plus one
  `display-floor` check: SwiftShader here can't hold the frame rate. Compare
  against a baseline run before blaming a change.
- `scripts/qa-*.mjs` are Puppeteer harnesses for specific features. They never
  start the server. Headless runs use SwiftShader, so screenshots are only
  relative evidence. See TESTING.md; for example, `qa-focus-evidence.mjs` only
  trusts frames that record `tilesSettled: true`.

## Architecture

**Server side (Node, runs inside Vite):**
- `vite.config.js` → `server/standalone/vite.config.js`, which loads `.env` into
  `process.env` and passes the local provider plugins to
  `createBrowserViteConfig` in `build/vite.js`. `build/vite.js` sets
  Cesium assets, `allowedHosts`, `fs.deny` for `.env`/`ENVIRONMENT`, and a
  `define` block that exposes **only** `GOOGLE_MAPS_API_KEY` and
  `CESIUM_ION_TOKEN` to the browser.
- `server/providers/local.js` (~4.7k lines) creates `localProviderPlugins()`,
  which mounts every `/api/*` route in order. Some provider families have been
  moved into their own modules: `live.js`, `aircraft/`, `vessels/`, `space/`,
  `places/`, `terrain.js`, `traffic.js`, `firms.js`, `gbfs.js` and `common/`
  (capped reads, coalescing, query parsing). The rest remain in `local.js`,
  including CCTV, Overpass, radio, realtime token, the setup/keys endpoint and
  the voice tool declarations (`GEV_REALTIME_TOOLS`).
- Security rules the proxies follow (see SECURITY.md):
  - Keys other than the two browser keys stay on the server; voice gets an
    ephemeral Realtime token.
  - No proxy fetches a URL the client supplies. CCTV fetches only
    server-registered frame URLs, and radio checks both an allowlist and the
    resolved IP.
  - Responses are size-capped and errors are sanitized.
  - The server binds to `localhost` by default because it is a key broker;
    `HOST=0.0.0.0` exposes it to the LAN.
- Keys are optional and set from the in-app **POWER UP → Provider Settings**
  panel. It writes the root `.env` (or `pinokio/ENVIRONMENT`) and
  restarts the server. `.env.example` documents every variable.

**Browser side:**
- `src/main.js` → `src/standalone/application.js`, which builds the app with
  `createApplication` from `src/app/application.js`. That module calls four
  caller-supplied constructors in order: scene (`standalone/scene.js`, the
  viewer and map), controls (`standalone/controls.js`, styles and camera),
  data (`standalone/data.js`, layer registration and share-link restoration)
  and tools (`standalone/tools.js`, scenes, annotations, voice and
  listeners). Each constructor receives an abort `signal` and a `defer` cleanup
  registrar. Destroying the application is final. See docs/APPLICATION.md.
- **Data layers:** each layer is one module in `src/data/<layer>.js` that
  implements `init/enable/disable/update/destroy/getStats`, plus
  `getDetectableObjects` for the detection overlay. They are registered with
  `DataLayerManager` (`src/data/manager.js`) in `standalone/data.js`. Layers
  poll their `/api/*` proxy themselves. Copy an existing layer as a template.
- `src/ui.js` (~10.5k lines) contains all panels, the HUD and the control
  facade. Keep layer logic in `src/data/` and UI code in `ui.js`.
- **Voice:** tools are declared on the server (`GEV_REALTIME_TOOLS` in
  `server/providers/local.js`) and run in the browser
  (`src/voice/gevActions.js`; the session is in `gevRealtime.js`). Replies
  should confirm only what actually happened. Partial failures must be
  reported, and fallbacks must be labelled.
- Other modules: `src/styles/` holds the GLSL post-process looks (thermal,
  noir, etc.), `src/annotations/` the voice whiteboard (resolver → GeoJSON →
  world/screen renderers), `src/overlays/worldOverlay.js` the screen-space
  labels, `src/scenes/` the camera director, and `renderGovernor.js` requests
  frames on demand.
- **Debugging from DevTools:** `window.__gevAnnotations` (`tour()`, `demo()`,
  `clear()`, `count()`, `annotate(...)`) and `window.__gevVoiceCommands`. In dev
  builds, the QA harnesses use `__gevQaRegisterLayer`.

**Package exports and boundaries:** `package.json` `exports` publish reusable
components (`./infrastructure`, `./application`, `./server/providers/*`,
`./sources/*`, `./build/vite`). `scripts/package-boundaries.json` lists
each export's owned modules and allowed external dependencies, and
`check:boundaries` enforces that list. When adding or expanding an export,
update that file and the consumer tests. Exports receive app operations through
callbacks, must not import `src/standalone/` or Node services, and keep Cesium
external. See docs/CODE-BOUNDARIES.md.

## Conventions

- Code style is 2-space indent, single quotes, semicolons, and JSDoc on exported
  functions. Prettier applies only to files adopted in
  `scripts/format-scope.json`; files outside that list keep their surrounding
  style. New modules are added to that list in a separate mechanical commit.
- `docs/CURRENT-STATE.md` is the authoritative runtime reference, and
  CONTRIBUTING says to read it first. Runtime behavior changes should update it
  and `CHANGELOG.md`. A new or changed data source should update
  `DATA_SOURCES.md` with its license and attribution. Don't bundle data you
  can't redistribute; fetch it at runtime instead.
- `docs/KNOWN-ISSUES.md` lists open bugs. `docs/PERFORMANCE.md` has the
  startup baseline.
