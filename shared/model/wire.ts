import { z } from "zod";

/**
 * Wire format: plain data the daemon streams to the client. Discriminated by `kind`.
 * The class model in `./node.ts` / `./connector.ts` is hydrated from this; it never crosses RPC.
 */

export const AGENT_STATES = ["idle", "thinking", "executing", "attention", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const SUBAGENT_STATES = ["running", "completed", "failed", "canceled"] as const;
export type SubagentState = (typeof SUBAGENT_STATES)[number];

export const WORKSPACE_STATES = ["needs_input", "failed", "running", "attention", "done"] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export const CHECK_STATES = ["none", "pending", "passing", "failing"] as const;

export const INTEGRATION_STATES = ["unknown", "included", "stale", "conflicts"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const FILE_OPS = ["read", "edit", "write"] as const;

const NodeBase = z.object({
  id: z.string(),
  label: z.string(),
  /** Cluster key: repo id for worktrees/branches, worktree id for agents/subagents/files. */
  group: z.string().optional(),
  /** Relative visual weight; 1 = default for the kind. */
  weight: z.number().positive().optional(),
});

export const UniverseNodeData = NodeBase.extend({
  kind: z.literal("universe"),
});
export const HostNodeData = NodeBase.extend({
  kind: z.literal("host"),
  serverId: z.string(),
  online: z.boolean(),
});
export const RepoNodeData = NodeBase.extend({
  kind: z.literal("repo"),
  hostId: z.string(),
  rootPath: z.string(),
  remoteUrl: z.string().optional(),
});
export const BASE_SOURCES = ["config", "inferred"] as const;
export const BranchNodeData = NodeBase.extend({
  kind: z.literal("branch"),
  repoId: z.string(),
  name: z.string(),
  headSha: z.string().optional(),
  /** The repository's default branch (origin/HEAD, else main/master). */
  isDefault: z.boolean(),
  /** Checked out in some worktree. */
  checkedOut: z.boolean(),
  /** Branch this one was branched from, when known (see `base-of` connector). */
  baseBranch: z.string().optional(),
});
export const WorktreeNodeData = NodeBase.extend({
  kind: z.literal("worktree"),
  repoId: z.string(),
  workspaceId: z.string().optional(),
  path: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  status: z.enum(WORKSPACE_STATES).optional(),
  diffStat: z.object({ additions: z.number().int(), deletions: z.number().int() }).optional(),
  /** Target of one or more `merges-into` connectors (see docs/DESIGN.md). */
  isIntegration: z.boolean(),
});
export const AgentNodeData = NodeBase.extend({
  kind: z.literal("agent"),
  worktreeId: z.string(),
  agentId: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  state: z.enum(AGENT_STATES),
  currentTool: z.string().optional(),
  currentFile: z.string().optional(),
  parentAgentId: z.string().optional(),
});
export const SubagentNodeData = NodeBase.extend({
  kind: z.literal("subagent"),
  parentAgentId: z.string(),
  state: z.enum(SUBAGENT_STATES),
  currentTool: z.string().optional(),
});
export const FileNodeData = NodeBase.extend({
  kind: z.literal("file"),
  worktreeId: z.string(),
  path: z.string(),
});
export const PrNodeData = NodeBase.extend({
  kind: z.literal("pr"),
  repoId: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(PR_STATES),
  checks: z.enum(CHECK_STATES),
  baseRef: z.string(),
  headRef: z.string(),
});

export const NodeData = z.discriminatedUnion("kind", [
  UniverseNodeData,
  HostNodeData,
  RepoNodeData,
  BranchNodeData,
  WorktreeNodeData,
  AgentNodeData,
  SubagentNodeData,
  FileNodeData,
  PrNodeData,
]);
export type NodeData = z.infer<typeof NodeData>;
export type NodeKind = NodeData["kind"];
export type NodeDataOf<K extends NodeKind> = Extract<NodeData, { kind: K }>;

const ConnectorBase = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
});

export const ContainsConnectorData = ConnectorBase.extend({ kind: z.literal("contains") });
export const BranchOfConnectorData = ConnectorBase.extend({ kind: z.literal("branch-of") });
/** `source` is the base branch, `target` the branch derived from it. */
export const BaseOfConnectorData = ConnectorBase.extend({
  kind: z.literal("base-of"),
  /** Where the relation came from: git config `branch.<name>.leylinebase` or fork-point inference. */
  via: z.enum(BASE_SOURCES),
  /** Commits on the derived branch since the fork point. */
  commitsAhead: z.number().int().nonnegative(),
});
export const SpawnedConnectorData = ConnectorBase.extend({ kind: z.literal("spawned") });
export const TouchesConnectorData = ConnectorBase.extend({
  kind: z.literal("touches"),
  op: z.enum(FILE_OPS),
});
export const MergesIntoConnectorData = ConnectorBase.extend({
  kind: z.literal("merges-into"),
  state: z.enum(INTEGRATION_STATES),
});
export const SharesContextConnectorData = ConnectorBase.extend({
  kind: z.literal("shares-context"),
  lastExchangeAt: z.string().optional(),
});

export const ConnectorData = z.discriminatedUnion("kind", [
  ContainsConnectorData,
  BranchOfConnectorData,
  BaseOfConnectorData,
  SpawnedConnectorData,
  TouchesConnectorData,
  MergesIntoConnectorData,
  SharesContextConnectorData,
]);
export type ConnectorData = z.infer<typeof ConnectorData>;
export type ConnectorKind = ConnectorData["kind"];
export type ConnectorDataOf<K extends ConnectorKind> = Extract<ConnectorData, { kind: K }>;

/** Connector kinds that define hierarchy (depth for the layered layout). */
export const TREE_CONNECTOR_KINDS: readonly ConnectorKind[] = ["contains", "spawned", "branch-of", "base-of", "touches", "merges-into"];

export const GraphPatch = z.object({
  upsertNodes: z.array(NodeData).optional(),
  removeNodes: z.array(z.string()).optional(),
  upsertConnectors: z.array(ConnectorData).optional(),
  removeConnectors: z.array(z.string()).optional(),
});
export type GraphPatch = z.infer<typeof GraphPatch>;
