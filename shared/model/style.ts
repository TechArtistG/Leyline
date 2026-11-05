import { z } from "zod";
import type { Connector } from "./connector";
import type { GraphNode } from "./node";
import type { ColorRef, ConnectorVisual, LabelSettings, NodeVisual } from "./visual";
import type { ConnectorKind, NodeKind } from "./wire";

/**
 * Graph look as data. Loaded from `.leyline/style.json` (project) or supplied programmatically;
 * `DEFAULT_STYLE` is the built-in. Rules are `kind` base + per-state overrides, where the state key
 * comes from `GraphNode.styleState` / `Connector.styleState`.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const ColorRefSchema: z.ZodType<ColorRef> = z.union([
  z.enum(["accent", "success", "warning", "danger", "muted", "foreground", "border"]),
  z.custom<`#${string}`>((v) => typeof v === "string" && HEX_COLOR.test(v), "hex colour"),
]);

export const LABEL_ANCHORS = ["above", "below", "left", "right"] as const;
export type LabelAnchor = (typeof LABEL_ANCHORS)[number];

/** Priority tiers for label level-of-detail; lower tier = shown first when zoomed out. */
export const LABEL_TIERS = ["project", "all"] as const;
export type LabelTier = (typeof LABEL_TIERS)[number];
const NodeStyle = z.object({
  /** Multiplier on the kind's default radius. */
  size: z.number().positive().optional(),
  color: ColorRefSchema.optional(),
  emissive: z.number().min(0).max(1).optional(),
  pulse: z.boolean().optional(),
  ring: ColorRefSchema.nullable().optional(),
  labelAlways: z.boolean().optional(),
  /** Screen-space side of the node the label sits on. Overrides `labels.anchor`. */
  labelAnchor: z.enum(LABEL_ANCHORS).optional(),
  /** `project` labels survive zooming out; `all` labels appear past `labels.lod.allAbovePxPerUnit`. */
  labelTier: z.enum(LABEL_TIERS).optional(),
  /** Not drawn, not simulated; incident connectors are hidden too. */
  hidden: z.boolean().optional(),
});
export type NodeStyle = z.infer<typeof NodeStyle>;

const NodeRule = NodeStyle.extend({
  states: z.record(z.string(), NodeStyle).optional(),
});

const ConnectorStyle = z.object({
  color: ColorRefSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  dashed: z.boolean().optional(),
  directed: z.boolean().optional(),
});
export type ConnectorStyle = z.infer<typeof ConnectorStyle>;

const ConnectorRule = ConnectorStyle.extend({
  states: z.record(z.string(), ConnectorStyle).optional(),
});

export const GraphStyle = z.object({
  /** Override theme-derived role colours with literal hex values. */
  palette: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  nodes: z.record(z.string(), NodeRule).optional(),
  connectors: z.record(z.string(), ConnectorRule).optional(),
  labels: z
    .object({
      /** Base screen-space size; labels never render smaller than this. */
      fontSizePx: z.number().positive().optional(),
      /** Labels grow with zoom up to this screen-space size. */
      maxFontSizePx: z.number().positive().optional(),
      color: ColorRefSchema.optional(),
      anchor: z.enum(LABEL_ANCHORS).optional(),
      /** Screen-space gap between the node's silhouette and the label. */
      offsetPx: z.number().min(0).optional(),
      lod: z
        .object({
          /** Pixels one world unit occupies on screen; below this only `project`-tier labels show. */
          allAbovePxPerUnit: z.number().positive().optional(),
          /** Pixels per world unit at which labels are exactly `fontSizePx`; scale grows linearly from here. */
          referencePxPerUnit: z.number().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Per-project containment: hull outline (2D) / bounding sphere (3D) drawn around each repo's nodes. */
  clusters: z
    .object({
      show: z.boolean().optional(),
      color: ColorRefSchema.optional(),
      opacity: z.number().min(0).max(1).optional(),
      /** World units of free space kept around each cluster's hull. */
      padding: z.number().min(0).optional(),
    })
    .optional(),
});
export type GraphStyle = z.infer<typeof GraphStyle>;

export const DEFAULT_STYLE: GraphStyle = {
  clusters: { show: true, color: "border", opacity: 0.25, padding: 2 },
  nodes: {
    universe: { color: "border", emissive: 0.2, labelAlways: true, labelTier: "project" },
    host: { color: "muted", labelAlways: true, labelTier: "project" },
    repo: { color: "muted", labelAlways: true, labelTier: "project" },
    branch: { color: "border", labelAlways: false },
    worktree: {
      color: "muted",
      labelAlways: true,
      states: {
        integration: { ring: "success", color: "foreground" },
        dirty: { ring: "warning" },
      },
    },
    agent: {
      color: "accent",
      emissive: 0.4,
      labelAlways: true,
      states: {
        thinking: { color: "warning", emissive: 0.6 },
        executing: { color: "success", emissive: 0.8, pulse: true },
        attention: { color: "warning", ring: "warning", emissive: 0.6 },
        error: { color: "danger", emissive: 0.6 },
      },
    },
    subagent: {
      color: "accent",
      emissive: 0.3,
      states: {
        running: { pulse: true, emissive: 0.6 },
        completed: { color: "muted", emissive: 0 },
        failed: { color: "danger" },
        canceled: { color: "border", emissive: 0 },
      },
    },
    file: { color: "foreground", hidden: true },
    pr: {
      color: "foreground",
      states: {
        draft: { color: "border" },
        merged: { color: "success" },
        closed: { color: "danger" },
      },
    },
  },
  connectors: {
    contains: { color: "border", opacity: 0.5 },
    "branch-of": { color: "border", opacity: 0.4, dashed: true },
    spawned: { color: "accent", opacity: 0.6, directed: true },
    touches: { color: "muted", opacity: 0.4, states: { write: { color: "warning" }, edit: { color: "warning" } } },
    "merges-into": {
      color: "success",
      opacity: 0.9,
      directed: true,
      states: { stale: { color: "warning" }, conflicts: { color: "danger" }, unknown: { color: "muted" } },
    },
    "shares-context": { color: "accent", opacity: 0.9, dashed: true },
  },
  labels: {
    fontSizePx: 13,
    maxFontSizePx: 22,
    color: "foreground",
    anchor: "above",
    offsetPx: 4,
    lod: { allAbovePxPerUnit: 14, referencePxPerUnit: 14 },
  },
};

export function parseGraphStyle(input: unknown): GraphStyle {
  return GraphStyle.parse(input);
}

/** Resolves visuals for the model against a style. Cheap to construct; construct once per style. */
export class StyleResolver {
  constructor(readonly style: GraphStyle = DEFAULT_STYLE) {}

  nodeVisual(node: GraphNode): NodeVisual {
    const rule = this.style.nodes?.[node.kind as NodeKind] ?? DEFAULT_STYLE.nodes?.[node.kind] ?? {};
    const state = node.styleState;
    const override = state ? rule.states?.[state] : undefined;
    const merged: NodeStyle = { ...rule, ...override };
    return {
      radius: node.radius * (merged.size ?? 1),
      color: merged.color ?? "muted",
      emissive: merged.emissive ?? 0,
      pulse: merged.pulse ?? false,
      ring: merged.ring ?? undefined,
      labelAlways: merged.labelAlways ?? false,
      labelAnchor: merged.labelAnchor ?? this.labels().anchor,
      labelTier: merged.labelTier ?? "all",
      hidden: merged.hidden ?? false,
    };
  }

  connectorVisual(connector: Connector): ConnectorVisual {
    const rule =
      this.style.connectors?.[connector.kind as ConnectorKind] ?? DEFAULT_STYLE.connectors?.[connector.kind] ?? {};
    const state = connector.styleState;
    const override = state ? rule.states?.[state] : undefined;
    const merged: ConnectorStyle = { ...rule, ...override };
    return {
      color: merged.color ?? "border",
      opacity: merged.opacity ?? 0.5,
      dashed: merged.dashed ?? false,
      directed: merged.directed ?? false,
    };
  }

  /** Fully-resolved global label settings. */
  labels(): LabelSettings {
    const d = DEFAULT_STYLE.labels!;
    const s = this.style.labels ?? {};
    return {
      fontSizePx: s.fontSizePx ?? d.fontSizePx!,
      maxFontSizePx: s.maxFontSizePx ?? d.maxFontSizePx!,
      color: s.color ?? d.color!,
      anchor: s.anchor ?? d.anchor!,
      offsetPx: s.offsetPx ?? d.offsetPx!,
      allAbovePxPerUnit: s.lod?.allAbovePxPerUnit ?? d.lod!.allAbovePxPerUnit!,
      referencePxPerUnit: s.lod?.referencePxPerUnit ?? d.lod!.referencePxPerUnit!,
    };
  }

  labelFontSizePx(): number {
    return this.labels().fontSizePx;
  }

  labelColor(): ColorRef {
    return this.labels().color;
  }

  clusterVisual(): { show: boolean; color: ColorRef; opacity: number; padding: number } {
    const c = { ...DEFAULT_STYLE.clusters, ...this.style.clusters };
    return { show: c.show ?? true, color: c.color ?? "border", opacity: c.opacity ?? 0.25, padding: c.padding ?? 2 };
  }
}
