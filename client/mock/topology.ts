import type { AgentState, GLink, GNode, GraphPatch, LinkKind } from "../../shared/graph";

/**
 * Deterministic multi-project fixture for proving out the layout: one host, four repos,
 * worktrees with agents/subagents, an integration worktree fed by two feature worktrees,
 * cross-worktree context sharing, touched files and one PR. No randomness, so the layout's
 * seeded initial positions are reproducible across reloads.
 */

const nodes: GNode[] = [];
const links: GLink[] = [];

function node(node: GNode): string {
  nodes.push(node);
  return node.id;
}

function link(kind: LinkKind, source: string, target: string): void {
  links.push({ id: `${kind}:${source}->${target}`, source, target, kind });
}

function repo(slug: string, label: string): string {
  const id = node({ id: `repo:${slug}`, kind: "repo", label, group: `repo:${slug}`, weight: 1.6 });
  link("contains", "host:local", id);
  return id;
}

/** Worktree inside `repoId`; `branch` is the checked-out branch name. */
function worktree(repoId: string, slug: string, branch: string): string {
  const repoSlug = repoId.slice("repo:".length);
  const id = node({ id: `wt:${repoSlug}/${slug}`, kind: "worktree", label: branch, group: repoId, weight: 1.2 });
  link("contains", repoId, id);
  return id;
}

function agent(worktreeId: string, index: number, label: string, state: AgentState): string {
  const id = node({ id: `agent:${worktreeId.slice("wt:".length)}/${index}`, kind: "agent", label, group: worktreeId, state });
  link("contains", worktreeId, id);
  return id;
}

function subagent(agentId: string, index: number, label: string, state: AgentState): string {
  const path = agentId.slice("agent:".length);
  const worktreeId = `wt:${path.slice(0, path.lastIndexOf("/"))}`;
  const id = node({ id: `sub:${path}/${index}`, kind: "subagent", label, group: worktreeId, state, weight: 0.7 });
  link("spawned", agentId, id);
  return id;
}

function file(worktreeId: string, path: string): string {
  return node({ id: `file:${worktreeId.slice("wt:".length)}/${path}`, kind: "file", label: path, group: worktreeId, weight: 0.5 });
}

function touches(agentId: string, worktreeId: string, paths: string[]): void {
  for (const path of paths) link("touches", agentId, file(worktreeId, path));
}

function build(): void {
  node({ id: "host:local", kind: "host", label: "local", weight: 2 });

  // GR_Agentic_Sim_Team_Infra: two feature worktrees merging into an integration worktree.
  const grInfra = repo("gr-infra", "GR_Agentic_Sim_Team_Infra");
  const grMain = node({ id: "branch:gr-infra/main", kind: "branch", label: "main", group: grInfra, weight: 0.8 });
  const grReviewRig = worktree(grInfra, "feature-kitbash-review-rig", "feature/kitbash-review-rig");
  const grMaterials = worktree(grInfra, "feature-kitbash-materials", "feature/kitbash-materials");
  const grIntegration = worktree(grInfra, "integration-kitbash", "integration/kitbash");
  link("branch-of", grIntegration, grMain);
  link("merges-into", grReviewRig, grIntegration);
  link("merges-into", grMaterials, grIntegration);

  const grRig1 = agent(grReviewRig, 1, "review rig builder", "executing");
  const grRig2 = agent(grReviewRig, 2, "rig QA", "thinking");
  const grRigScout = subagent(grRig1, 1, "scout: USD schema", "idle");
  subagent(grRig1, 2, "camera presets", "executing");
  subagent(grRig1, 3, "lighting pass", "thinking");
  touches(grRig1, grReviewRig, ["sim/kitbash/review_rig.py", "sim/kitbash/assets.yaml"]);
  touches(grRigScout, grReviewRig, ["sim/kitbash/schema/usd_rig.md"]);
  const grMat1 = agent(grMaterials, 1, "materials importer", "attention");
  agent(grIntegration, 1, "integration merger", "idle");

  // GRID
  const grid = repo("grid", "GRID");
  const gridMain = worktree(grid, "main", "main");
  const gridCache = worktree(grid, "feature-scene-graph-cache", "feature/scene-graph-cache");
  link("branch-of", gridCache, gridMain);
  agent(gridMain, 1, "release notes", "idle");
  const gridCache1 = agent(gridCache, 1, "cache implementer", "executing");
  agent(gridCache, 2, "bench runner", "error");
  subagent(gridCache1, 1, "profile hot paths", "executing");
  touches(gridCache1, gridCache, ["src/scene/cache.rs", "src/scene/mod.rs"]);

  // isaac-sim-mcp
  const isaac = repo("isaac-sim-mcp", "isaac-sim-mcp");
  const isaacMain = worktree(isaac, "main", "main");
  const isaac1 = agent(isaacMain, 1, "mcp tool author", "thinking");

  // Leyline
  const leyline = repo("leyline", "Leyline");
  const leylineMain = worktree(leyline, "main", "main");
  const leylineLayout = worktree(leyline, "feature-force-layout", "feature/force-layout");
  link("branch-of", leylineLayout, leylineMain);
  agent(leylineMain, 1, "docs keeper", "idle");
  const leyline1 = agent(leylineLayout, 1, "renderer", "executing");
  const leyline2 = agent(leylineLayout, 2, "fixtures & panel", "attention");
  subagent(leyline1, 1, "d3-force-3d typings", "executing");
  subagent(leyline1, 2, "orbit controls", "idle");
  touches(leyline1, leylineLayout, ["client/renderer/layout.ts", "client/web.ts", "shared/graph.ts"]);
  const pr = node({ id: "pr:leyline/42", kind: "pr", label: "#42 physics layout + 2D/3D", group: leyline, weight: 0.9 });
  link("merges-into", leylineLayout, pr);

  // Agents collaborating across worktrees (and across repos).
  link("shares-context", grRig2, grMat1);
  link("shares-context", isaac1, leyline2);
}

build();

export function mockTopology(): GraphPatch {
  return { upsertNodes: nodes.map((n) => ({ ...n })), upsertLinks: links.map((l) => ({ ...l })) };
}
