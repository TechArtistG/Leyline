import type { NodeData, NodeDataOf, NodeKind } from "./wire";

/** Default radius per kind; `weight` scales it. */
export const KIND_RADIUS: Record<NodeKind, number> = {
  universe: 2.0,
  host: 1.6,
  repo: 1.3,
  branch: 0.7,
  worktree: 1.0,
  agent: 0.9,
  subagent: 0.6,
  file: 0.4,
  pr: 0.8,
};

/**
 * Git is the web, agents are the spiders. Web nodes are laid out by the simulation; spider nodes
 * are positioned relative to their `anchorId` and move along the web as it changes.
 */
export type NodeLayer = "web" | "spider";
export const KIND_LAYER: Record<NodeKind, NodeLayer> = {
  universe: "web",
  host: "web",
  repo: "web",
  branch: "web",
  worktree: "web",
  file: "web",
  pr: "web",
  agent: "spider",
  subagent: "spider",
};

/**
 * In-memory node. Hydrated from wire `NodeData`, mutated through `update()`, read by the
 * renderer through the style resolver and the kind-specific fields on each subclass.
 */
export abstract class GraphNode<K extends NodeKind = NodeKind> {
  readonly id: string;
  readonly kind: K;
  label: string;
  group: string | undefined;
  weight: number;
  /** Bumped on every change `update()` reports; renderers compare it to skip untouched nodes. */
  revision = 0;

  protected constructor(data: NodeDataOf<K>) {
    this.id = data.id;
    this.kind = data.kind;
    this.label = data.label;
    this.group = data.group;
    this.weight = data.weight ?? 1;
  }

  get radius(): number {
    return KIND_RADIUS[this.kind] * this.weight;
  }

  get layer(): NodeLayer {
    return KIND_LAYER[this.kind];
  }

  /** Spider nodes: id of the web node (or parent spider) this node rides on. Web nodes: undefined. */
  get anchorId(): string | undefined {
    return undefined;
  }

  /** Key into the style's per-kind `states` map (e.g. an agent's state); undefined = base rule. */
  abstract get styleState(): string | undefined;

  /** Serialise back to wire data (full, not a diff). */
  abstract toData(): NodeDataOf<K>;

  /**
   * Apply new wire data. Returns true when anything observable changed, in which case
   * `revision` has been bumped. `id` and `kind` are immutable.
   */
  update(data: NodeData): boolean {
    if (data.id !== this.id || data.kind !== this.kind) {
      throw new Error(`update mismatch for ${this.id}/${this.kind}: got ${data.id}/${data.kind}`);
    }
    let changed = false;
    const weight = data.weight ?? 1;
    if (data.label !== this.label) (this.label = data.label), (changed = true);
    if (data.group !== this.group) (this.group = data.group), (changed = true);
    if (weight !== this.weight) (this.weight = weight), (changed = true);
    if (this.applyData(data as NodeDataOf<K>)) changed = true;
    if (changed) this.revision++;
    return changed;
  }

  /** Subclass hook: copy kind-specific fields, return whether any differed. */
  protected abstract applyData(data: NodeDataOf<K>): boolean;

  protected baseData(): { id: string; kind: K; label: string; group?: string; weight?: number } {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      ...(this.group !== undefined ? { group: this.group } : {}),
      ...(this.weight !== 1 ? { weight: this.weight } : {}),
    };
  }
}
