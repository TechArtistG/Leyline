import type { Connector } from "./connector";
import {
  BaseOfConnector,
  BranchOfConnector,
  ContainsConnector,
  MergesIntoConnector,
  SharesContextConnector,
  SpawnedConnector,
  TouchesConnector,
} from "./connectors";
import type { GraphNode } from "./node";
import {
  AgentNode,
  BranchNode,
  FileNode,
  HostNode,
  PrNode,
  RepoNode,
  SubagentNode,
  UniverseNode,
  WorktreeNode,
} from "./nodes";
import type { ConnectorByKind } from "./connectors";
import type { NodeByKind } from "./nodes";
import type { ConnectorData, ConnectorKind, NodeData, NodeKind } from "./wire";

export function createNode(data: NodeData): GraphNode {
  switch (data.kind) {
    case "universe":
      return new UniverseNode(data);
    case "host":
      return new HostNode(data);
    case "repo":
      return new RepoNode(data);
    case "branch":
      return new BranchNode(data);
    case "worktree":
      return new WorktreeNode(data);
    case "agent":
      return new AgentNode(data);
    case "subagent":
      return new SubagentNode(data);
    case "file":
      return new FileNode(data);
    case "pr":
      return new PrNode(data);
    default: {
      const never: never = data;
      throw new Error(`unknown node kind: ${JSON.stringify(never)}`);
    }
  }
}

export function createConnector(data: ConnectorData): Connector {
  switch (data.kind) {
    case "contains":
      return new ContainsConnector(data);
    case "branch-of":
      return new BranchOfConnector(data);
    case "base-of":
      return new BaseOfConnector(data);
    case "spawned":
      return new SpawnedConnector(data);
    case "touches":
      return new TouchesConnector(data);
    case "merges-into":
      return new MergesIntoConnector(data);
    case "shares-context":
      return new SharesContextConnector(data);
    default: {
      const never: never = data;
      throw new Error(`unknown connector kind: ${JSON.stringify(never)}`);
    }
  }
}

export function isNodeKind<K extends NodeKind>(node: GraphNode, kind: K): node is NodeByKind[K] {
  return node.kind === kind;
}

export function isConnectorKind<K extends ConnectorKind>(connector: Connector, kind: K): connector is ConnectorByKind[K] {
  return connector.kind === kind;
}
