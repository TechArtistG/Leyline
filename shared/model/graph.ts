import type { Connector } from "./connector";
import { createConnector, createNode } from "./factory";
import type { GraphNode } from "./node";
import type { GraphPatch } from "./wire";

export type GraphChange =
  | { type: "node"; op: "add" | "update" | "remove"; id: string }
  | { type: "connector"; op: "add" | "update" | "remove"; id: string };

export type GraphListener = (changes: readonly GraphChange[]) => void;

/**
 * The in-memory graph: nodes and connectors as class instances plus adjacency.
 * `applyPatch` is the only mutation entry point; listeners receive one batched change list per patch.
 */
export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly connectors = new Map<string, Connector>();
  private readonly incident = new Map<string, Set<string>>();
  private readonly listeners = new Set<GraphListener>();

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  connector(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  /** Connectors touching `nodeId` in either direction. */
  connectorsOf(nodeId: string): Connector[] {
    const ids = this.incident.get(nodeId);
    if (!ids) return [];
    const out: Connector[] = [];
    for (const id of ids) {
      const c = this.connectors.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  /** Ids of nodes directly connected to `nodeId`. */
  neighbors(nodeId: string): string[] {
    return this.connectorsOf(nodeId).map((c) => (c.source === nodeId ? c.target : c.source));
  }

  subscribe(listener: GraphListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply a wire patch in order: node upserts, connector upserts, connector removals, node removals
   * (which cascade to incident connectors). Connectors whose endpoints are missing are dropped.
   */
  applyPatch(patch: GraphPatch): readonly GraphChange[] {
    const changes: GraphChange[] = [];

    for (const data of patch.upsertNodes ?? []) {
      const existing = this.nodes.get(data.id);
      if (existing) {
        if (existing.update(data)) changes.push({ type: "node", op: "update", id: data.id });
      } else {
        this.nodes.set(data.id, createNode(data));
        this.incident.set(data.id, new Set());
        changes.push({ type: "node", op: "add", id: data.id });
      }
    }

    for (const data of patch.upsertConnectors ?? []) {
      if (!this.nodes.has(data.source) || !this.nodes.has(data.target)) continue;
      const existing = this.connectors.get(data.id);
      if (existing) {
        if (existing.source !== data.source || existing.target !== data.target || existing.kind !== data.kind) {
          this.removeConnector(existing.id, changes);
          this.addConnector(createConnector(data), changes);
        } else if (existing.update(data)) {
          changes.push({ type: "connector", op: "update", id: data.id });
        }
      } else {
        this.addConnector(createConnector(data), changes);
      }
    }

    for (const id of patch.removeConnectors ?? []) this.removeConnector(id, changes);

    for (const id of patch.removeNodes ?? []) {
      if (!this.nodes.has(id)) continue;
      for (const cid of [...(this.incident.get(id) ?? [])]) this.removeConnector(cid, changes);
      this.nodes.delete(id);
      this.incident.delete(id);
      changes.push({ type: "node", op: "remove", id });
    }

    if (changes.length) for (const listener of this.listeners) listener(changes);
    return changes;
  }

  /** Full snapshot as a wire patch. */
  toPatch(): GraphPatch {
    return {
      upsertNodes: [...this.nodes.values()].map((n) => n.toData()),
      upsertConnectors: [...this.connectors.values()].map((c) => c.toData()),
    };
  }

  private addConnector(connector: Connector, changes: GraphChange[]): void {
    this.connectors.set(connector.id, connector);
    this.incident.get(connector.source)?.add(connector.id);
    this.incident.get(connector.target)?.add(connector.id);
    changes.push({ type: "connector", op: "add", id: connector.id });
  }

  private removeConnector(id: string, changes: GraphChange[]): void {
    const c = this.connectors.get(id);
    if (!c) return;
    this.connectors.delete(id);
    this.incident.get(c.source)?.delete(id);
    this.incident.get(c.target)?.delete(id);
    changes.push({ type: "connector", op: "remove", id });
  }
}
