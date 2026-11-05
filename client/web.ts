import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import type * as Line2Module from "three/addons/lines/Line2.js";
import type * as LineGeometryModule from "three/addons/lines/LineGeometry.js";
import type * as LineMaterialModule from "three/addons/lines/LineMaterial.js";
import type * as LineSegments2Module from "three/addons/lines/LineSegments2.js";
import type * as LineSegmentsGeometryModule from "three/addons/lines/LineSegmentsGeometry.js";
import { Platform } from "react-native";
import type { GraphHandle, GraphMode } from "../shared/graph";
import type { Graph } from "../shared/model/graph";
import type { GraphStyle } from "../shared/model/style";
import { type HostElement, createGraphRenderer } from "./renderer/graph-renderer";

export type { GraphEvent, GraphHandle, GraphMode } from "../shared/graph";

/**
 * Web gate: mount the graph renderer into the DOM node React Native Web created for a `<View ref>`.
 * Returns `null` on native. The WebGL dependencies are loaded with dynamic `import()` rather than
 * `require()`: three's CJS entry is a deprecated shim that calls `process.emitWarning`, which
 * Paseo's client bundle does not provide, and loading lazily keeps native from evaluating them.
 */
export async function mountGraph(
  parent: unknown,
  theme: PluginTheme,
  mode: GraphMode,
  graph: Graph,
  style?: GraphStyle,
): Promise<GraphHandle | null> {
  if (Platform.OS !== "web" || !parent) return null;
  const THREE: typeof Three = await import("three");
  // three's `./addons/*` subpath export; verified under Paseo's bundler by the spike.
  const { OrbitControls }: typeof OrbitControlsModule = await import("three/addons/controls/OrbitControls.js");
  // Fat lines: WebGL ignores `lineWidth > 1`, so connectors and agent rings are screen-space quads.
  const { LineSegments2 }: typeof LineSegments2Module = await import("three/addons/lines/LineSegments2.js");
  const { LineSegmentsGeometry }: typeof LineSegmentsGeometryModule = await import("three/addons/lines/LineSegmentsGeometry.js");
  const { LineMaterial }: typeof LineMaterialModule = await import("three/addons/lines/LineMaterial.js");
  const { Line2 }: typeof Line2Module = await import("three/addons/lines/Line2.js");
  const { LineGeometry }: typeof LineGeometryModule = await import("three/addons/lines/LineGeometry.js");
  const d3: typeof D3 = await import("d3-force-3d");
  return createGraphRenderer(parent as HostElement, theme, mode, graph, style, {
    THREE,
    OrbitControls,
    d3,
    LineSegments2,
    LineSegmentsGeometry,
    LineMaterial,
    Line2,
    LineGeometry,
  });
}
