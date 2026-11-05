import type {
  AgentState,
  ConnectorData,
  ConnectorDataOf,
  GraphPatch,
  IntegrationState,
  NodeData,
  SubagentState,
} from "../../shared/model/wire";

/**
 * Deterministic multi-project fixture for proving out the layout: one host, four repos,
 * worktrees with agents/subagents, an integration worktree fed by two feature worktrees,
 * cross-worktree context sharing, touched files and one PR. No randomness, so the layout's
 * seeded initial positions are reproducible across reloads.
 */

const nodes: NodeData[] = [];
const connectors: ConnectorData[] = [];

function node(node: NodeData): string {
  nodes.push(node);
  return node.id;
}

type PlainKind = "contains" | "branch-of" | "spawned" | "shares-context";

function connector(data: ConnectorData): void {
  connectors.push(data);
}

function link(kind: PlainKind, source: string, target: string): void {
  connector({ id: `${kind}:${source}->${target}`, source, target, kind });
}

function mergesInto(source: string, target: string, state: IntegrationState): void {
  connector({ id: `merges-into:${source}->${target}`, source, target, kind: "merges-into", state });
}

function baseOf(source: string, target: string, via: ConnectorDataOf<"base-of">["via"], commitsAhead: number): void {
  connector({ id: `base-of:${source}->${target}`, source, target, kind: "base-of", via, commitsAhead });
}

/**
 * Branch node in `repoId`. Checked-out branches hang off `worktreeId`; the default branch (and
 * branches with no known base) hang off the repo; based branches hang off their base via `base-of`.
 */
function branch(
  repoId: string,
  name: string,
  opts: { worktreeId?: string; isDefault?: boolean; base?: { name: string; via: "config" | "inferred"; commitsAhead: number } } = {},
): string {
  const repoSlug = repoId.slice("repo:".length);
  const id = node({
    id: `branch:${repoSlug}/${name}`,
    kind: "branch",
    label: name,
    group: repoId,
    weight: opts.isDefault ? 1.2 : opts.worktreeId ? 1 : 0.6,
    repoId,
    name,
    isDefault: opts.isDefault ?? false,
    checkedOut: opts.worktreeId !== undefined,
    baseBranch: opts.base?.name,
  });
  if (opts.worktreeId) link("contains", opts.worktreeId, id);
  if (opts.base) baseOf(`branch:${repoSlug}/${opts.base.name}`, id, opts.base.via, opts.base.commitsAhead);
  if (opts.isDefault || (!opts.base && !opts.worktreeId)) link("branch-of", repoId, id);
  return id;
}

function repo(slug: string, label: string): string {
  const id = node({
    id: `repo:${slug}`,
    kind: "repo",
    label,
    group: `repo:${slug}`,
    weight: 1.6,
    hostId: "host:local",
    rootPath: `/srv/repos/${slug}`,
  });
  link("contains", "host:local", id);
  return id;
}

/** Worktree inside `repoId`; `branch` is the checked-out branch name. */
function worktree(
  repoId: string,
  slug: string,
  branch: string,
  opts: { dirty?: boolean; ahead?: number; behind?: number; isIntegration?: boolean } = {},
): string {
  const repoSlug = repoId.slice("repo:".length);
  const id = node({
    id: `wt:${repoSlug}/${slug}`,
    kind: "worktree",
    label: branch,
    group: repoId,
    weight: 1.2,
    repoId,
    path: `/srv/repos/${repoSlug}/${slug}`,
    branch,
    dirty: opts.dirty ?? false,
    ahead: opts.ahead ?? 0,
    behind: opts.behind ?? 0,
    isIntegration: opts.isIntegration ?? false,
  });
  link("contains", repoId, id);
  return id;
}

/**
 * Agent on `worktreeId`; `parentId` (an agent node id on the same worktree) makes it a child
 * context — `parentAgentId` carries the parent's paseo agent id, as the builder reads it from the
 * `paseo.parent-agent-id` label — which the renderer draws as a spoke on the parent's ring.
 */
function agent(worktreeId: string, index: number, label: string, state: AgentState, parentId?: string): string {
  const path = `${worktreeId.slice("wt:".length)}/${index}`;
  const id = node({
    id: `agent:${path}`,
    kind: "agent",
    label,
    group: worktreeId,
    worktreeId,
    agentId: path,
    provider: "omp",
    state,
    parentAgentId: parentId?.slice("agent:".length),
  });
  link("contains", worktreeId, id);
  return id;
}

function subagent(agentId: string, index: number, label: string, state: SubagentState): string {
  const path = agentId.slice("agent:".length);
  const worktreeId = `wt:${path.slice(0, path.lastIndexOf("/"))}`;
  const id = node({
    id: `sub:${path}/${index}`,
    kind: "subagent",
    label,
    group: worktreeId,
    weight: 0.7,
    parentAgentId: agentId,
    state,
  });
  link("spawned", agentId, id);
  return id;
}

function file(worktreeId: string, path: string): string {
  return node({
    id: `file:${worktreeId.slice("wt:".length)}/${path}`,
    kind: "file",
    label: path,
    group: worktreeId,
    weight: 0.5,
    worktreeId,
    path,
  });
}

function touches(agentId: string, worktreeId: string, paths: string[], op: ConnectorDataOf<"touches">["op"] = "edit"): void {
  for (const path of paths) {
    const target = file(worktreeId, path);
    connector({ id: `touches:${agentId}->${target}`, source: agentId, target, kind: "touches", op });
  }
}

function build(): void {
  node({ id: "universe", kind: "universe", label: "Universe" });
  node({ id: "host:local", kind: "host", label: "local", weight: 2, serverId: "local", online: true });
  link("contains", "universe", "host:local");

  // GR_Agentic_Sim_Team_Infra: two feature worktrees merging into an integration worktree.
  const grInfra = repo("gr-infra", "GR_Agentic_Sim_Team_Infra");
  const grMain = branch(grInfra, "main", { isDefault: true });
  const grReviewRig = worktree(grInfra, "feature-kitbash-review-rig", "feature/kitbash-review-rig", { dirty: true, ahead: 4 });
  const grMaterials = worktree(grInfra, "feature-kitbash-materials", "feature/kitbash-materials", { ahead: 2, behind: 1 });
  const grIntegration = worktree(grInfra, "integration-kitbash", "integration/kitbash", { isIntegration: true, ahead: 6 });
  link("branch-of", grIntegration, grMain);
  branch(grInfra, "integration/kitbash", { worktreeId: grIntegration, base: { name: "main", via: "config", commitsAhead: 6 } });
  branch(grInfra, "feature/kitbash-review-rig", { worktreeId: grReviewRig, base: { name: "main", via: "config", commitsAhead: 4 } });
  // Branched from the integration branch rather than main.
  branch(grInfra, "feature/kitbash-materials", {
    worktreeId: grMaterials,
    base: { name: "integration/kitbash", via: "config", commitsAhead: 3 },
  });
  mergesInto(grReviewRig, grIntegration, "included");
  mergesInto(grMaterials, grIntegration, "stale");

  // Root agent with a child agent (spoke) and subagents: one ring.
  const grRig1 = agent(grReviewRig, 1, "review rig builder", "executing");
  const grRig2 = agent(grReviewRig, 2, "rig QA", "thinking", grRig1);
  const grRigScout = subagent(grRig1, 1, "scout: USD schema", "completed");
  subagent(grRig1, 2, "camera presets", "running");
  subagent(grRig1, 3, "lighting pass", "running");
  touches(grRig1, grReviewRig, ["sim/kitbash/review_rig.py", "sim/kitbash/assets.yaml"]);
  touches(grRigScout, grReviewRig, ["sim/kitbash/schema/usd_rig.md"], "read");
  const grMat1 = agent(grMaterials, 1, "materials importer", "attention");
  agent(grIntegration, 1, "integration merger", "idle");

  // GRID
  const grid = repo("grid", "GRID");
  const gridMain = worktree(grid, "main", "main");
  const gridCache = worktree(grid, "feature-scene-graph-cache", "feature/scene-graph-cache", { dirty: true, ahead: 3 });
  link("branch-of", gridCache, gridMain);
  branch(grid, "main", { worktreeId: gridMain, isDefault: true });
  branch(grid, "feature/scene-graph-cache", { worktreeId: gridCache, base: { name: "main", via: "inferred", commitsAhead: 3 } });
  agent(gridMain, 1, "release notes", "idle");
  // Two independent root agents on one checkout: two concentric rings.
  const gridCache1 = agent(gridCache, 1, "cache implementer", "executing");
  agent(gridCache, 2, "bench runner", "error");
  subagent(gridCache1, 1, "profile hot paths", "running");
  touches(gridCache1, gridCache, ["src/scene/cache.rs", "src/scene/mod.rs"]);

  // isaac-sim-mcp
  const isaac = repo("isaac-sim-mcp", "isaac-sim-mcp");
  const isaacMain = worktree(isaac, "main", "main");
  branch(isaac, "main", { worktreeId: isaacMain, isDefault: true });
  const isaac1 = agent(isaacMain, 1, "mcp tool author", "thinking");

  // Leyline
  const leyline = repo("leyline", "Leyline");
  const leylineMain = worktree(leyline, "main", "main");
  const leylineLayout = worktree(leyline, "feature-force-layout", "feature/force-layout", { dirty: true, ahead: 9, behind: 2 });
  link("branch-of", leylineLayout, leylineMain);
  branch(leyline, "main", { worktreeId: leylineMain, isDefault: true });
  branch(leyline, "feature/force-layout", { worktreeId: leylineLayout, base: { name: "main", via: "config", commitsAhead: 9 } });
  agent(leylineMain, 1, "docs keeper", "idle");
  const leyline1 = agent(leylineLayout, 1, "renderer", "executing");
  const leyline2 = agent(leylineLayout, 2, "fixtures & panel", "attention", leyline1);
  subagent(leyline1, 1, "d3-force-3d typings", "running");
  subagent(leyline1, 2, "orbit controls", "completed");
  touches(leyline1, leylineLayout, ["client/renderer/layout.ts", "client/web.ts", "shared/graph.ts"]);
  const pr = node({
    id: "pr:leyline/42",
    kind: "pr",
    label: "#42 physics layout + 2D/3D",
    group: leyline,
    weight: 0.9,
    repoId: leyline,
    number: 42,
    url: "https://github.com/omp/Leyline/pull/42",
    state: "open",
    checks: "passing",
    baseRef: "main",
    headRef: "feature/force-layout",
  });
  mergesInto(leylineLayout, pr, "unknown");

  // Agents collaborating across worktrees (and across repos).
  link("shares-context", grRig2, grMat1);
  link("shares-context", isaac1, leyline2);
}

build();

export function mockTopology(): GraphPatch {
  return { upsertNodes: nodes.map((n) => ({ ...n })), upsertConnectors: connectors.map((c) => ({ ...c })) };
}
