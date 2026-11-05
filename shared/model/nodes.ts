import { GraphNode } from "./node";
import { compact, syncFields } from "./sync";
import type { AgentState, NodeDataOf, SubagentState, WorkspaceState } from "./wire";

type PrState = NodeDataOf<"pr">["state"];
type CheckState = NodeDataOf<"pr">["checks"];
type DiffStat = NonNullable<NodeDataOf<"worktree">["diffStat"]>;

export class UniverseNode extends GraphNode<"universe"> {
  public constructor(data: NodeDataOf<"universe">) {
    super(data);
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): NodeDataOf<"universe"> {
    return this.baseData();
  }

  protected applyData(): boolean {
    return false;
  }
}

export class HostNode extends GraphNode<"host"> {
  serverId: string;
  online: boolean;

  public constructor(data: NodeDataOf<"host">) {
    super(data);
    this.serverId = data.serverId;
    this.online = data.online;
  }

  get styleState(): string | undefined {
    return this.online ? undefined : "offline";
  }

  toData(): NodeDataOf<"host"> {
    return { ...this.baseData(), serverId: this.serverId, online: this.online };
  }

  protected applyData(data: NodeDataOf<"host">): boolean {
    return syncFields(this, data, ["serverId", "online"]);
  }
}

export class RepoNode extends GraphNode<"repo"> {
  hostId: string;
  rootPath: string;
  remoteUrl: string | undefined;

  public constructor(data: NodeDataOf<"repo">) {
    super(data);
    this.hostId = data.hostId;
    this.rootPath = data.rootPath;
    this.remoteUrl = data.remoteUrl;
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): NodeDataOf<"repo"> {
    return compact({ ...this.baseData(), hostId: this.hostId, rootPath: this.rootPath, remoteUrl: this.remoteUrl });
  }

  protected applyData(data: NodeDataOf<"repo">): boolean {
    return syncFields(this, data, ["hostId", "rootPath", "remoteUrl"]);
  }
}

export class BranchNode extends GraphNode<"branch"> {
  repoId: string;
  name: string;
  headSha: string | undefined;
  isDefault: boolean;
  checkedOut: boolean;
  baseBranch: string | undefined;

  public constructor(data: NodeDataOf<"branch">) {
    super(data);
    this.repoId = data.repoId;
    this.name = data.name;
    this.headSha = data.headSha;
    this.isDefault = data.isDefault;
    this.checkedOut = data.checkedOut;
    this.baseBranch = data.baseBranch;
  }

  get styleState(): string | undefined {
    return this.isDefault ? "default" : this.checkedOut ? "checkedOut" : undefined;
  }

  toData(): NodeDataOf<"branch"> {
    return compact({
      ...this.baseData(),
      repoId: this.repoId,
      name: this.name,
      headSha: this.headSha,
      isDefault: this.isDefault,
      checkedOut: this.checkedOut,
      baseBranch: this.baseBranch,
    });
  }

  protected applyData(data: NodeDataOf<"branch">): boolean {
    return syncFields(this, data, ["repoId", "name", "headSha", "isDefault", "checkedOut", "baseBranch"]);
  }
}

export class WorktreeNode extends GraphNode<"worktree"> {
  repoId: string;
  workspaceId: string | undefined;
  path: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  status: WorkspaceState | undefined;
  diffStat: DiffStat | undefined;
  isIntegration: boolean;

  public constructor(data: NodeDataOf<"worktree">) {
    super(data);
    this.repoId = data.repoId;
    this.workspaceId = data.workspaceId;
    this.path = data.path;
    this.branch = data.branch;
    this.dirty = data.dirty;
    this.ahead = data.ahead;
    this.behind = data.behind;
    this.status = data.status;
    this.diffStat = data.diffStat ? { ...data.diffStat } : undefined;
    this.isIntegration = data.isIntegration;
  }

  get styleState(): string | undefined {
    if (this.isIntegration) return "integration";
    if (this.dirty) return "dirty";
    return undefined;
  }

  toData(): NodeDataOf<"worktree"> {
    return compact({
      ...this.baseData(),
      repoId: this.repoId,
      workspaceId: this.workspaceId,
      path: this.path,
      branch: this.branch,
      dirty: this.dirty,
      ahead: this.ahead,
      behind: this.behind,
      status: this.status,
      diffStat: this.diffStat ? { ...this.diffStat } : undefined,
      isIntegration: this.isIntegration,
    });
  }

  protected applyData(data: NodeDataOf<"worktree">): boolean {
    let changed = syncFields(this, data, [
      "repoId",
      "workspaceId",
      "path",
      "branch",
      "dirty",
      "ahead",
      "behind",
      "status",
      "isIntegration",
    ]);
    const next = data.diffStat;
    const cur = this.diffStat;
    if (
      (next === undefined) !== (cur === undefined) ||
      (next && cur && (next.additions !== cur.additions || next.deletions !== cur.deletions))
    ) {
      this.diffStat = next ? { ...next } : undefined;
      changed = true;
    }
    return changed;
  }
}

export class AgentNode extends GraphNode<"agent"> {
  worktreeId: string;
  agentId: string;
  provider: string;
  model: string | undefined;
  state: AgentState;
  currentTool: string | undefined;
  currentFile: string | undefined;
  parentAgentId: string | undefined;

  public constructor(data: NodeDataOf<"agent">) {
    super(data);
    this.worktreeId = data.worktreeId;
    this.agentId = data.agentId;
    this.provider = data.provider;
    this.model = data.model;
    this.state = data.state;
    this.currentTool = data.currentTool;
    this.currentFile = data.currentFile;
    this.parentAgentId = data.parentAgentId;
  }

  get anchorId(): string | undefined {
    return this.worktreeId;
  }

  get styleState(): string | undefined {
    return this.state;
  }

  toData(): NodeDataOf<"agent"> {
    return compact({
      ...this.baseData(),
      worktreeId: this.worktreeId,
      agentId: this.agentId,
      provider: this.provider,
      model: this.model,
      state: this.state,
      currentTool: this.currentTool,
      currentFile: this.currentFile,
      parentAgentId: this.parentAgentId,
    });
  }

  protected applyData(data: NodeDataOf<"agent">): boolean {
    return syncFields(this, data, [
      "worktreeId",
      "agentId",
      "provider",
      "model",
      "state",
      "currentTool",
      "currentFile",
      "parentAgentId",
    ]);
  }
}

export class SubagentNode extends GraphNode<"subagent"> {
  parentAgentId: string;
  state: SubagentState;
  currentTool: string | undefined;

  public constructor(data: NodeDataOf<"subagent">) {
    super(data);
    this.parentAgentId = data.parentAgentId;
    this.state = data.state;
    this.currentTool = data.currentTool;
  }

  get anchorId(): string | undefined {
    return this.parentAgentId;
  }

  get styleState(): string | undefined {
    return this.state;
  }

  toData(): NodeDataOf<"subagent"> {
    return compact({
      ...this.baseData(),
      parentAgentId: this.parentAgentId,
      state: this.state,
      currentTool: this.currentTool,
    });
  }

  protected applyData(data: NodeDataOf<"subagent">): boolean {
    return syncFields(this, data, ["parentAgentId", "state", "currentTool"]);
  }
}

export class FileNode extends GraphNode<"file"> {
  worktreeId: string;
  path: string;

  public constructor(data: NodeDataOf<"file">) {
    super(data);
    this.worktreeId = data.worktreeId;
    this.path = data.path;
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): NodeDataOf<"file"> {
    return { ...this.baseData(), worktreeId: this.worktreeId, path: this.path };
  }

  protected applyData(data: NodeDataOf<"file">): boolean {
    return syncFields(this, data, ["worktreeId", "path"]);
  }
}

export class PrNode extends GraphNode<"pr"> {
  repoId: string;
  number: number;
  url: string;
  state: PrState;
  checks: CheckState;
  baseRef: string;
  headRef: string;

  public constructor(data: NodeDataOf<"pr">) {
    super(data);
    this.repoId = data.repoId;
    this.number = data.number;
    this.url = data.url;
    this.state = data.state;
    this.checks = data.checks;
    this.baseRef = data.baseRef;
    this.headRef = data.headRef;
  }

  get styleState(): string | undefined {
    return this.state;
  }

  toData(): NodeDataOf<"pr"> {
    return {
      ...this.baseData(),
      repoId: this.repoId,
      number: this.number,
      url: this.url,
      state: this.state,
      checks: this.checks,
      baseRef: this.baseRef,
      headRef: this.headRef,
    };
  }

  protected applyData(data: NodeDataOf<"pr">): boolean {
    return syncFields(this, data, ["repoId", "number", "url", "state", "checks", "baseRef", "headRef"]);
  }
}

export type NodeByKind = {
  universe: UniverseNode;
  host: HostNode;
  repo: RepoNode;
  branch: BranchNode;
  worktree: WorktreeNode;
  agent: AgentNode;
  subagent: SubagentNode;
  file: FileNode;
  pr: PrNode;
};
