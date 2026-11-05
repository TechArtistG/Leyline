import type {
  OwnedSubscription,
  PaseoAgent,
  PaseoApi,
  PaseoProject,
  PaseoProjectUpdate,
  PaseoWorkspace,
} from "@getpaseo/client";
import type { RpcOutput } from "@getpaseo/plugin";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { listBranchesRpc } from "../../shared/contracts";
import type { Graph } from "../../shared/model/graph";
import type { AgentState, ConnectorData, NodeData } from "../../shared/model/wire";

/**
 * Live topology: mirrors Paseo's workspace/agent/project directories plus per-repo git data into the
 * `Graph`. Paseo state lives in plain maps; every change schedules one coalesced `recompute()` that
 * derives the full desired node/connector set and diffs it against what was emitted last time.
 *
 * Node ids: `universe`, `host:<hostId>`, `repo:<projectId>`, `wt:<workspaceId>` (Paseo workspace),
 * `wt:git:<projectId>/<basename>` (git worktree Paseo does not know), `branch:<projectId>/<name>`,
 * `agent:<agentId>`, `sub:<subagentId>`. Connectors: `<kind>:<source>-><target>`, parent → child.
 */

export type ListBranchesOutput = RpcOutput<typeof listBranchesRpc>;
type GitWorktree = ListBranchesOutput["worktrees"][number];

type SubagentUpdate = Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>["payload"];
type PaseoSubagent = Extract<SubagentUpdate, { kind: "upsert" }>["subagent"];

export interface TopologyOptions {
  paseo: PaseoApi;
  hostId: string;
  hostLabel: string;
  graph: Graph;
  listBranches: (input: { repoRoot: string }) => Promise<ListBranchesOutput>;
  /** Restrict the graph to the project owning this workspace (the workspace panel). */
  scope?: { workspaceId: string };
  /** Latest error summary, or `null` once everything is healthy again. */
  onError?: (error: string | null) => void;
}

export interface TopologyHandle {
  /** Releases every Paseo subscription and clears timers. Safe to call twice. */
  stop(): void;
}

const GIT_POLL_MS = 15_000;
const PAGE_LIMIT = 200;
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const DETACHED = "(detached)";

interface GitEntry {
  data: ListBranchesOutput | null;
  inFlight: boolean;
}

interface ProjectView {
  id: string;
  label: string;
  rootPath: string;
  kind: PaseoProject["projectKind"];
  workspaces: PaseoWorkspace[];
}

/** Path key for matching Paseo workspace directories with `git worktree list` output. */
export function normalizePath(path: string): string {
  let out = path.replace(/\\/g, "/");
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1) || normalized;
}

function agentState(agent: PaseoAgent): AgentState | null {
  if (agent.status === "closed") return null;
  if (agent.status === "error") return "error";
  if (agent.requiresAttention) return "attention";
  if (agent.status === "running") return "executing";
  return "idle";
}

class TopologyBuilder implements TopologyHandle {
  private readonly workspaces = new Map<string, PaseoWorkspace>();
  private readonly agents = new Map<string, PaseoAgent>();
  private readonly projects = new Map<string, PaseoProject>();
  private readonly subagents = new Map<string, PaseoSubagent>();
  /** Keyed by repo root path as Paseo reports it. */
  private readonly git = new Map<string, GitEntry>();
  private readonly errors = new Map<string, string>();
  private lastError: string | null = null;

  private emittedNodes = new Set<string>();
  private emittedConnectors = new Set<string>();
  /** Project the scoped workspace belongs to; remembered so archiving it does not blank the panel. */
  private scopedProjectId: string | null = null;

  private readonly subscriptions: OwnedSubscription<unknown>[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private recomputeTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly opts: TopologyOptions) {}

  start(): void {
    this.pollTimer = setInterval(() => {
      for (const root of this.git.keys()) void this.refreshGit(root);
    }, GIT_POLL_MS);
    void this.subscribeWorkspaces();
    void this.subscribeAgents();
    void this.subscribeProjects();
    void this.subscribeEvents();
    this.schedule();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.recomputeTimer);
    clearInterval(this.pollTimer);
    this.recomputeTimer = undefined;
    this.pollTimer = undefined;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const subscription of this.subscriptions.splice(0)) void subscription.release().catch(() => undefined);
  }

  // ---- Paseo subscriptions -------------------------------------------------------------------

  /**
   * Registers an owned subscription; releases it immediately when `stop()` already ran.
   * `snapshot` fires with the initial directory and again after a reconnect re-delivers it.
   */
  private own<T>(subscription: OwnedSubscription<T>, name: string, snapshot: (snapshot: T) => void): boolean {
    if (this.stopped) {
      void subscription.release().catch(() => undefined);
      return false;
    }
    this.subscriptions.push(subscription);
    this.unsubscribers.push(
      subscription.subscribe({
        snapshot,
        update: (message) => this.onMessage(message),
        error: (error) => this.fail(name, error),
      }),
    );
    return true;
  }

  private async subscribeWorkspaces(): Promise<void> {
    try {
      const result = await this.opts.paseo.workspaces.list({ subscribe: {}, page: { limit: PAGE_LIMIT } });
      const applied = this.own(result.subscription, "workspaces", (s) => this.replaceWorkspaces(s.entries));
      if (!applied) return;
      this.replaceWorkspaces(result.entries);
      this.ok("workspaces");
    } catch (cause) {
      this.fail("workspaces", cause);
    }
  }

  private async subscribeAgents(): Promise<void> {
    try {
      const result = await this.opts.paseo.agents.list({ subscribe: {}, page: { limit: PAGE_LIMIT } });
      const applied = this.own(result.subscription, "agents", (s) => this.replaceAgents(s.entries));
      if (!applied) return;
      this.replaceAgents(result.entries);
      this.ok("agents");
    } catch (cause) {
      this.fail("agents", cause);
    }
  }

  private async subscribeProjects(): Promise<void> {
    if (this.stopped) return;
    this.unsubscribers.push(this.opts.paseo.projects.subscribe((update) => this.onProjectUpdate(update)));
    try {
      const result = await this.opts.paseo.projects.list();
      if (this.stopped) return;
      this.projects.clear();
      for (const project of result.projects) this.projects.set(project.projectId, project);
      this.ok("projects");
      this.schedule();
    } catch (cause) {
      this.fail("projects", cause);
    }
  }

  /**
   * Event stream for subagents (no directory exists for them) and project updates. `projects.subscribe`
   * is a local listener only; asking the daemon for `project.update` here guarantees it actually streams.
   */
  private async subscribeEvents(): Promise<void> {
    const subscription = this.opts.paseo.observeEvents(["agent.provider_subagents.update", "project.update"]);
    if (!this.own(subscription, "events", () => undefined)) return;
    try {
      await subscription.ready;
      this.ok("events");
    } catch (cause) {
      this.fail("events", cause);
    }
  }

  private onMessage(message: SessionOutboundMessage): void {
    switch (message.type) {
      case "workspace_update": {
        const payload = message.payload;
        if (payload.kind === "upsert") this.upsertWorkspace(payload.workspace);
        else {
          this.workspaces.delete(payload.id);
          if (payload.emptyProject) this.projects.set(payload.emptyProject.projectId, payload.emptyProject);
          if (payload.removedProjectId) this.projects.delete(payload.removedProjectId);
        }
        this.schedule();
        return;
      }
      case "agent_update": {
        const payload = message.payload;
        if (payload.kind === "upsert") this.agents.set(payload.agent.id, payload.agent);
        else this.agents.delete(payload.agentId);
        this.schedule();
        return;
      }
      case "agent.provider_subagents.update": {
        const payload = message.payload;
        if (payload.kind === "upsert") this.subagents.set(payload.subagent.id, payload.subagent);
        else if (payload.kind === "remove") this.subagents.delete(payload.subagentId);
        else return; // timeline items carry no topology
        this.schedule();
        return;
      }
      case "project.update":
        this.onProjectUpdate(message.payload);
        return;
      default:
        return;
    }
  }

  private onProjectUpdate(update: PaseoProjectUpdate): void {
    if (update.kind === "upsert") this.projects.set(update.project.projectId, update.project);
    else this.projects.delete(update.projectId);
    this.schedule();
  }

  private replaceWorkspaces(entries: PaseoWorkspace[]): void {
    const previous = new Map(this.workspaces);
    this.workspaces.clear();
    for (const workspace of entries) this.upsertWorkspace(workspace, previous.get(workspace.id));
    this.schedule();
  }

  private upsertWorkspace(workspace: PaseoWorkspace, previous = this.workspaces.get(workspace.id)): void {
    this.workspaces.set(workspace.id, workspace);
    // A new worktree or a checkout changes what git reports; refresh now rather than at the next poll.
    const branch = workspace.gitRuntime?.currentBranch ?? null;
    const changed = !previous || (previous.gitRuntime?.currentBranch ?? null) !== branch;
    if (changed && workspace.projectKind === "git" && this.git.has(workspace.projectRootPath)) {
      void this.refreshGit(workspace.projectRootPath);
    }
  }

  private replaceAgents(entries: ReadonlyArray<{ agent: PaseoAgent }>): void {
    this.agents.clear();
    for (const { agent } of entries) this.agents.set(agent.id, agent);
    this.schedule();
  }

  // ---- Git -----------------------------------------------------------------------------------

  private async refreshGit(root: string): Promise<void> {
    const entry = this.git.get(root);
    if (!entry || entry.inFlight) return;
    entry.inFlight = true;
    try {
      const data = await this.opts.listBranches({ repoRoot: root });
      if (this.stopped || !this.git.has(root)) return;
      entry.data = data;
      if (data.error) this.fail(`git ${basename(root)}`, data.error);
      else this.ok(`git ${basename(root)}`);
      this.schedule();
    } catch (cause) {
      if (!this.stopped) this.fail(`git ${basename(root)}`, cause);
    } finally {
      entry.inFlight = false;
    }
  }

  /** Keeps `git` keyed exactly by the repo roots currently shown; new roots are fetched at once. */
  private syncGitRoots(roots: Set<string>): void {
    for (const root of this.git.keys()) {
      if (!roots.has(root)) {
        this.git.delete(root);
        this.ok(`git ${basename(root)}`);
      }
    }
    for (const root of roots) {
      if (this.git.has(root)) continue;
      this.git.set(root, { data: null, inFlight: false });
      void this.refreshGit(root);
    }
  }

  // ---- Errors --------------------------------------------------------------------------------

  private fail(source: string, cause: unknown): void {
    this.errors.set(source, `${source}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.publishErrors();
  }

  private ok(source: string): void {
    if (this.errors.delete(source)) this.publishErrors();
  }

  private publishErrors(): void {
    if (this.stopped) return;
    const summary = this.errors.size ? [...this.errors.values()].join(" · ") : null;
    if (summary === this.lastError) return;
    this.lastError = summary;
    this.opts.onError?.(summary);
  }

  // ---- Derivation ----------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopped || this.recomputeTimer !== undefined) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = undefined;
      this.recompute();
    }, 0);
  }

  private visibleProjects(): ProjectView[] {
    const views = new Map<string, ProjectView>();
    const view = (id: string, label: string, rootPath: string, kind: ProjectView["kind"]): ProjectView => {
      let existing = views.get(id);
      if (!existing) {
        existing = { id, label, rootPath, kind, workspaces: [] };
        views.set(id, existing);
      }
      return existing;
    };
    for (const project of this.projects.values()) {
      view(project.projectId, project.projectDisplayName, project.projectRootPath, project.projectKind);
    }
    for (const workspace of this.workspaces.values()) {
      if (workspace.internal || workspace.archivingAt) continue;
      view(workspace.projectId, workspace.projectDisplayName, workspace.projectRootPath, workspace.projectKind).workspaces.push(
        workspace,
      );
    }
    const scope = this.opts.scope;
    if (!scope) return [...views.values()];
    const scoped = this.workspaces.get(scope.workspaceId);
    if (scoped) this.scopedProjectId = scoped.projectId;
    const project = this.scopedProjectId ? views.get(this.scopedProjectId) : undefined;
    return project ? [project] : [];
  }

  private recompute(): void {
    if (this.stopped) return;
    const { hostId, hostLabel } = this.opts;
    const nodes = new Map<string, NodeData>();
    const connectors = new Map<string, ConnectorData>();
    const node = (data: NodeData): string => {
      nodes.set(data.id, data);
      return data.id;
    };
    const link = (kind: "contains" | "branch-of" | "spawned", source: string, target: string): void => {
      const id = `${kind}:${source}->${target}`;
      connectors.set(id, { id, kind, source, target });
    };

    const universeId = node({ id: "universe", kind: "universe", label: "universe" });
    const hostNodeId = node({ id: `host:${hostId}`, kind: "host", label: hostLabel, serverId: hostId, online: true });
    link("contains", universeId, hostNodeId);

    /** Worktree node id by normalized directory, across all projects (agents are matched by cwd). */
    const worktreeByPath = new Map<string, string>();
    const gitRoots = new Set<string>();

    for (const project of this.visibleProjects()) {
      const repoId = `repo:${project.id}`;
      const git = project.kind === "git" ? this.git.get(project.rootPath)?.data ?? null : null;
      if (project.kind === "git") gitRoots.add(project.rootPath);

      const gitWorktrees = new Map<string, GitWorktree>();
      if (git) for (const worktree of git.worktrees) gitWorktrees.set(normalizePath(worktree.path), worktree);
      const headSha = new Map<string, string>();
      if (git?.branches) for (const branch of git.branches) headSha.set(branch.name, branch.headSha);

      let remoteUrl: string | undefined;
      /** Branch name → worktree node that has it checked out. */
      const checkedOut = new Map<string, string>();
      const claimed = new Set<string>();

      for (const workspace of project.workspaces) {
        const key = normalizePath(workspace.workspaceDirectory);
        const gitWorktree = gitWorktrees.get(key);
        const runtime = workspace.gitRuntime;
        remoteUrl ??= runtime?.remoteUrl ?? undefined;
        const branch = runtime?.currentBranch ?? gitWorktree?.branch ?? null;
        const worktreeId = node({
          id: `wt:${workspace.id}`,
          kind: "worktree",
          label: workspace.name,
          group: repoId,
          weight: 1,
          repoId,
          workspaceId: workspace.id,
          path: workspace.workspaceDirectory,
          branch: branch ?? DETACHED,
          dirty: runtime?.isDirty ?? false,
          ahead: runtime?.aheadBehind?.ahead ?? 0,
          behind: runtime?.aheadBehind?.behind ?? 0,
          status: workspace.status,
          diffStat: workspace.diffStat ?? undefined,
          isIntegration: false,
        });
        link("contains", repoId, worktreeId);
        worktreeByPath.set(key, worktreeId);
        claimed.add(key);
        if (branch !== null && !checkedOut.has(branch)) checkedOut.set(branch, worktreeId);
      }

      if (git) {
        git.worktrees.forEach((worktree, index) => {
          const key = normalizePath(worktree.path);
          if (claimed.has(key)) return;
          claimed.add(key);
          let id = `wt:git:${project.id}/${basename(worktree.path)}`;
          if (nodes.has(id)) id = `${id}#${index}`;
          const worktreeId = node({
            id,
            kind: "worktree",
            label: worktree.branch ?? basename(worktree.path),
            group: repoId,
            weight: 0.7,
            repoId,
            path: worktree.path,
            branch: worktree.branch ?? DETACHED,
            dirty: false,
            ahead: 0,
            behind: 0,
            isIntegration: false,
          });
          link("contains", repoId, worktreeId);
          worktreeByPath.set(key, worktreeId);
          if (worktree.branch !== null && !checkedOut.has(worktree.branch)) checkedOut.set(worktree.branch, worktreeId);
        });
      }

      node({
        id: repoId,
        kind: "repo",
        label: project.label,
        group: repoId,
        weight: 1.6,
        hostId: hostNodeId,
        rootPath: project.rootPath,
        remoteUrl,
      });
      link("contains", hostNodeId, repoId);

      const branchNode = (name: string, weight: number): string =>
        node({
          id: `branch:${project.id}/${name}`,
          kind: "branch",
          label: name,
          group: repoId,
          weight,
          repoId,
          name,
          headSha: headSha.get(name),
        });
      for (const [name, worktreeId] of checkedOut) link("contains", worktreeId, branchNode(name, 1));
      if (git?.branches) {
        for (const branch of git.branches) {
          if (checkedOut.has(branch.name)) continue;
          link("branch-of", repoId, branchNode(branch.name, 0.6));
        }
      }
    }

    /** Agent node id → its worktree node id, for subagent grouping. */
    const agentWorktree = new Map<string, string>();
    for (const agent of this.agents.values()) {
      if (agent.archivedAt || agent.internal) continue;
      const state = agentState(agent);
      if (state === null) continue;
      let worktreeId = agent.workspaceId ? `wt:${agent.workspaceId}` : undefined;
      if (!worktreeId || !nodes.has(worktreeId)) worktreeId = worktreeByPath.get(normalizePath(agent.cwd));
      if (!worktreeId) continue;
      const agentId = node({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.title ?? agent.id,
        group: worktreeId,
        worktreeId,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model ?? undefined,
        state,
        parentAgentId: agent.labels[PARENT_AGENT_LABEL],
      });
      link("contains", worktreeId, agentId);
      agentWorktree.set(agentId, worktreeId);
    }

    for (const subagent of this.subagents.values()) {
      if (!this.agents.has(subagent.parentAgentId)) {
        this.subagents.delete(subagent.id); // parent gone for good; stop carrying it
        continue;
      }
      const parentId = `agent:${subagent.parentAgentId}`;
      const worktreeId = agentWorktree.get(parentId);
      if (!worktreeId) continue;
      const subId = node({
        id: `sub:${subagent.id}`,
        kind: "subagent",
        label: subagent.title ?? subagent.subtitle ?? subagent.id,
        group: worktreeId,
        weight: 0.7,
        parentAgentId: parentId,
        state: subagent.status,
      });
      link("spawned", parentId, subId);
    }

    this.syncGitRoots(gitRoots);

    const removeNodes: string[] = [];
    for (const id of this.emittedNodes) if (!nodes.has(id)) removeNodes.push(id);
    const removeConnectors: string[] = [];
    for (const id of this.emittedConnectors) if (!connectors.has(id)) removeConnectors.push(id);
    this.opts.graph.applyPatch({
      upsertNodes: [...nodes.values()],
      upsertConnectors: [...connectors.values()],
      removeNodes,
      removeConnectors,
    });
    this.emittedNodes = new Set(nodes.keys());
    this.emittedConnectors = new Set(connectors.keys());
  }
}

export function startTopology(opts: TopologyOptions): TopologyHandle {
  const builder = new TopologyBuilder(opts);
  builder.start();
  return builder;
}
