# ADR-001: Graph renderer

Status: accepted (2026-11-05)

## Decision

Build the graph renderer on **three.js directly** (`three` + `d3-force-3d`, `three-forcegraph` as the graph `Object3D` where it fits), not on `react-force-graph`, `reagraph`, or React Flow.

- 2D mode = orthographic camera + 2-dimensional force simulation; 3D mode = perspective camera + 3-dimensional simulation; same scene graph and data model.
- VR is aspirational. The scene is kept XR-compatible (`renderer.setAnimationLoop`, no DOM-only node content on the shared path) but no XR work is scheduled. Electron ships no OpenXR ([electron#35011](https://github.com/electron/electron/issues/35011)), so VR would mean serving the renderer to a WebXR browser.
- Rich HTML node content (diffs, `AGENTS.md`) is a DOM overlay positioned from projected node coordinates, or a side panel; not part of the WebGL scene.

## Spike results (Paseo 0.15.2, three 0.187.0, Windows, Electron)

- three loads inside a plugin workspace panel and renders: `three r187, WebGL 2.0 (OpenGL ES 3.0 Chromium)`.
- `three/addons/controls/OrbitControls.js` subpath export bundles fine.
- `require("three")` **fails**: it resolves to the deprecated CJS shim `build/three.cjs`, which calls `process.emitWarning`; Paseo's client bundle stubs `process` without it. Use dynamic `import("three")` inside the `Platform.OS === "web"` gate (`client/web.ts`).
- Mount target: the DOM node React Native Web creates for a `<View ref>`; `ResizeObserver` on it drives renderer/camera resize.
- Host React is 19.1.0 (`@getpaseo/plugin` 0.15.2 devDependencies) → `@react-three/fiber` 9 is viable if a declarative scene becomes worthwhile.

## Alternatives considered

| Option | Why not |
|---|---|
| `react-force-graph-2d` / `-3d` | Separate components per mode (simulation state lost on switch); VR flavour is A-Frame, page-owning |
| `reagraph` | Owns the r3f `<Canvas>`, no XR hook; 385 KB gz; smaller community |
| `@xyflow/react` | 2D DOM only; would be a second renderer, not a stepping stone |

## Consequences

- We own controls, picking (raycast), hover/tooltips, fit-to-view, and prop diffing (est. 300–600 LOC).
- Renderer is behind the `GraphRenderer` interface in `shared/graph.ts` / `client/renderer/`, fed by `GraphPatch` streams from the daemon side.
