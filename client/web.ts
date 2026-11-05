import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import { Platform } from "react-native";
import type { GraphHandle, GraphMode } from "../shared/graph";
import { type HostElement, createGraphRenderer } from "./renderer/graph-renderer";

export type { GraphEvent, GraphHandle, GraphMode, GraphPatch } from "../shared/graph";

/**
 * Web gate: mount the graph renderer into the DOM node React Native Web created for a `<View ref>`.
 * Returns `null` on native. The WebGL dependencies are loaded with dynamic `import()` rather than
 * `require()`: three's CJS entry is a deprecated shim that calls `process.emitWarning`, which
 * Paseo's client bundle does not provide, and loading lazily keeps native from evaluating them.
 */
export async function mountGraph(parent: unknown, theme: PluginTheme, mode: GraphMode): Promise<GraphHandle | null> {
  if (Platform.OS !== "web" || !parent) return null;
  const THREE: typeof Three = await import("three");
  // three's `./addons/*` subpath export; verified under Paseo's bundler by the spike.
  const { OrbitControls }: typeof OrbitControlsModule = await import("three/addons/controls/OrbitControls.js");
  const d3: typeof D3 = await import("d3-force-3d");
  return createGraphRenderer(parent as HostElement, theme, mode, { THREE, OrbitControls, d3 });
}
