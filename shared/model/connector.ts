import type { ConnectorData, ConnectorDataOf, ConnectorKind } from "./wire";

/** Preferred resting length per kind in world units; layouts scale it. */
export const KIND_DISTANCE: Record<ConnectorKind, number> = {
  contains: 6,
  "branch-of": 5,
  "base-of": 5,
  spawned: 4,
  touches: 3,
  "merges-into": 8,
  "shares-context": 10,
};

/**
 * In-memory directed connector between two nodes. Same lifecycle as `GraphNode`: hydrated
 * from wire data, mutated through `update()`, read by the renderer through `visual`.
 */
export abstract class Connector<K extends ConnectorKind = ConnectorKind> {
  readonly id: string;
  readonly kind: K;
  readonly source: string;
  readonly target: string;
  revision = 0;

  protected constructor(data: ConnectorDataOf<K>) {
    this.id = data.id;
    this.kind = data.kind;
    this.source = data.source;
    this.target = data.target;
  }

  get distance(): number {
    return KIND_DISTANCE[this.kind];
  }

  /** Key into the style's per-kind `states` map; undefined = base rule. */
  abstract get styleState(): string | undefined;

  abstract toData(): ConnectorDataOf<K>;

  /** Apply new wire data; `id`, `kind`, `source`, `target` are immutable. */
  update(data: ConnectorData): boolean {
    if (data.id !== this.id || data.kind !== this.kind || data.source !== this.source || data.target !== this.target) {
      throw new Error(`update mismatch for connector ${this.id}`);
    }
    const changed = this.applyData(data as ConnectorDataOf<K>);
    if (changed) this.revision++;
    return changed;
  }

  protected abstract applyData(data: ConnectorDataOf<K>): boolean;

  protected baseData(): { id: string; kind: K; source: string; target: string } {
    return { id: this.id, kind: this.kind, source: this.source, target: this.target };
  }
}
