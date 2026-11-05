import { z } from "zod";

/** Renderer-agnostic graph model shared by the daemon-side topology builder and the client renderer. */

export const NODE_KINDS = ["host", "repo", "branch", "worktree", "agent", "subagent", "file", "pr"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const AGENT_STATES = ["idle", "thinking", "executing", "attention", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const LINK_KINDS = ["contains", "branch-of", "merges-into", "spawned", "shares-context", "touches"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const GNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  label: z.string(),
  /** Cluster key (repo id for worktrees/branches, worktree id for agents). Drives grouping forces. */
  group: z.string().optional(),
  state: z.enum(AGENT_STATES).optional(),
  /** Relative visual weight; 1 = default. */
  weight: z.number().positive().optional(),
});
export type GNode = z.infer<typeof GNodeSchema>;

export const GLinkSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum(LINK_KINDS),
});
export type GLink = z.infer<typeof GLinkSchema>;

export const GraphPatchSchema = z.object({
  upsertNodes: z.array(GNodeSchema).optional(),
  removeNodes: z.array(z.string()).optional(),
  upsertLinks: z.array(GLinkSchema).optional(),
  removeLinks: z.array(z.string()).optional(),
});
export type GraphPatch = z.infer<typeof GraphPatchSchema>;

/**
 * `2d-lr`: layered left→right (depth from the containment tree fixes x; forces settle y).
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
  apply(patch: GraphPatch): void;
  setMode(mode: GraphMode): void;
  /** Re-run the layout from deterministic initial positions. */
  relayout(): void;
  /** Frame all nodes in view. */
  fit(): void;
  on(listener: (event: GraphEvent) => void): () => void;
  destroy(): void;
}
