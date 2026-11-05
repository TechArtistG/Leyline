import type { Graph } from "./model/graph";
import type { GraphStyle } from "./model/style";

/**
 * `2d-lr`: layered left→right (depth from the tree connectors fixes x; forces settle y).
 * `2d-hub`: hub-and-spoke force layout in the XY plane.
 * `3d-hub`: hub-and-spoke force layout in 3D.
 */
export type GraphMode = "2d-lr" | "2d-hub" | "3d-hub";
export const GRAPH_MODES: readonly GraphMode[] = ["2d-lr", "2d-hub", "3d-hub"];
export const GRAPH_MODE_LABELS: Record<GraphMode, string> = { "2d-lr": "2D →", "2d-hub": "2D hub", "3d-hub": "3D hub" };

export type GraphEvent = { type: "select"; id: string | null } | { type: "hover"; id: string | null };

/** What the web-only renderer exposes to React. Implemented in `client/renderer/`. */
export interface GraphHandle {
  /** Human-readable init summary (three revision, GL version). */
  readonly info: string;
  /** The model this renderer draws; mutate it via `graph.applyPatch`, the renderer subscribes. */
  readonly graph: Graph;
  setMode(mode: GraphMode): void;
  /** Swap the look; re-resolves every node/connector visual. */
  setStyle(style: GraphStyle): void;
  /** Re-run the layout from deterministic initial positions. */
  relayout(): void;
  /** Frame all nodes in view. */
  fit(): void;
  on(listener: (event: GraphEvent) => void): () => void;
  destroy(): void;
}
