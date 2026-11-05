import { z } from "zod";
import type { Connector } from "./connector";
import type { GraphNode } from "./node";
import type { AgentRingVisual, ColorRef, ConnectorVisual, LabelSettings, NodeVisual } from "./visual";
import { NODE_SHAPES } from "./visual";
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
  /** 0..1 mix of `color` toward `foreground` (a lighter tint of the same role). */
  lighten: z.number().min(0).max(1).optional(),
  /** Derive the colour from a stable hash of the node's label (one hue per project name); overrides `color`. */
  colorByLabel: z.boolean().optional(),
  /** Mesh shape. */
  shape: z.enum(NODE_SHAPES).optional(),
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
  /** Screen-space line width in px. */
  width: z.number().positive().optional(),
  dashed: z.boolean().optional(),
  directed: z.boolean().optional(),
  /** Parallel lines drawn for one connector (1 or 2). Two lanes march in opposite directions. */
  lanes: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Dash march speed in world units per second; 0 = static. Requires `dashed`. */
  marchSpeed: z.number().min(0).optional(),
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
      /** Both thresholds are measured per project: at the repo cluster's centre in `3d-hub`, uniformly in 2D modes. */
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
  /** How the selected node's connectors differ from the default look. */
  selection: z
    .object({
      /** Multiplier on the connector's `width`. */
      widthScale: z.number().positive().optional(),
      /** 0..1 mix of the connector colour toward `foreground`. */
      lighten: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /**
   * Agentic work drawn as modifiers on a worktree: one ring per root agent anchored to it
   * (concentric when several; dashed and rotating while the agent executes) and one radial spoke
   * per subagent or child agent on that agent's ring — two parallel dashed lanes, counter-marching
   * while it runs — ending in a ring tip (dashed and rotating while it runs).
   */
  agentRings: z
    .object({
      show: z.boolean().optional(),
      color: ColorRefSchema.optional(),
      /** Screen-space ring line width in px. */
      width: z.number().positive().optional(),
      /** First ring radius as a multiple of the node radius. */
      innerScale: z.number().positive().optional(),
      /** World-unit gap between concentric rings. */
      spacing: z.number().positive().optional(),
      /** Degrees per second for active (dashed) rings and tips. */
      rotateDegPerSec: z.number().optional(),
      /** Spoke length (ring edge to tip centre) as a multiple of the node radius. */
      spokeScale: z.number().positive().optional(),
      /** Spoke tip ring radius as a multiple of the node radius. */
      spokeTipScale: z.number().positive().optional(),
      /** Half-separation of a spoke's two lanes from its centre line, world units. */
      spokeLaneGap: z.number().positive().optional(),
      /** Minimum on-screen inner ring radius in px: a set whose inner ring would be smaller is scaled up to it. Spokes hide below 1.5× this (±10 % hysteresis). */
      minRadiusPx: z.number().positive().optional(),
      /** 0..1 mix of the ring colour toward `foreground` for a running subagent's tip. */
      spokeLighten: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type GraphStyle = z.infer<typeof GraphStyle>;

export const DEFAULT_STYLE: GraphStyle = {
  clusters: { show: true, color: "border", opacity: 0.25, padding: 2 },
  selection: { widthScale: 2, lighten: 0.45 },
  agentRings: {
    show: true,
    color: "warning",
    width: 4,
    innerScale: 1.35,
    spacing: 0.3,
    rotateDegPerSec: 45,
    spokeScale: 1.1,
    spokeTipScale: 0.45,
    spokeLaneGap: 0.12,
    minRadiusPx: 16,
    spokeLighten: 0.35,
  },
  nodes: {
    universe: { color: "border", emissive: 0.2, labelAlways: true, labelTier: "project" },
    host: { color: "muted", shape: "dodecahedron-frame", size: 1.3, labelAlways: true, labelTier: "project" },
    repo: { color: "muted", colorByLabel: true, shape: "dodecahedron-cluster", labelAlways: true, labelTier: "project" },
    branch: {
      color: "border",
      labelAlways: false,
      states: {
        default: { color: "foreground", size: 1.4, labelAlways: true, labelTier: "project" },
        checkedOut: { color: "muted", labelAlways: true },
      },
    },
    worktree: {
      color: "muted",
      shape: "dodecahedron",
      labelAlways: true,
      states: {
        integration: { ring: "success", color: "foreground" },
        dirty: { color: "foreground", lighten: 0.2 },
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
      color: "warning",
      lighten: 0.35,
      emissive: 0.3,
      states: {
        running: { pulse: true, emissive: 0.6 },
        completed: { color: "muted", lighten: 0, emissive: 0 },
        failed: { color: "danger", lighten: 0 },
        canceled: { color: "border", lighten: 0, emissive: 0 },
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
    contains: { color: "muted", opacity: 0.85, width: 1.5 },
    "branch-of": { color: "muted", opacity: 0.7, width: 1.25, dashed: true },
    "base-of": {
      color: "foreground",
      opacity: 0.8,
      width: 1.5,
      directed: true,
      states: { inferred: { dashed: true, opacity: 0.6 } },
    },
    spawned: { color: "warning", opacity: 0.9, width: 1.25, dashed: true, lanes: 2, marchSpeed: 2 },
    touches: { color: "muted", opacity: 0.7, width: 1.25, states: { write: { color: "warning" }, edit: { color: "warning" } } },
    "merges-into": {
      color: "success",
      opacity: 1,
      width: 2,
      directed: true,
      states: { stale: { color: "warning" }, conflicts: { color: "danger" }, unknown: { color: "muted" } },
    },
    "shares-context": { color: "accent", opacity: 1, width: 2, dashed: true },
  },
  labels: {
    fontSizePx: 13,
    maxFontSizePx: 22,
    color: "foreground",
    anchor: "above",
    offsetPx: 4,
    lod: { allAbovePxPerUnit: 6, referencePxPerUnit: 8 },
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
      lighten: merged.lighten ?? 0,
      colorByLabel: merged.colorByLabel ?? false,
      shape: merged.shape ?? "sphere",
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
      width: merged.width ?? 1.5,
      dashed: merged.dashed ?? false,
      directed: merged.directed ?? false,
      lanes: merged.lanes ?? 1,
      marchSpeed: merged.marchSpeed ?? 0,
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

  clusterVisual(): { show: boolean; color: ColorRef; opacity: number; padding: number } {
    const c = { ...DEFAULT_STYLE.clusters, ...this.style.clusters };
    return { show: c.show ?? true, color: c.color ?? "border", opacity: c.opacity ?? 0.25, padding: c.padding ?? 2 };
  }

  selectionVisual(): { widthScale: number; lighten: number } {
    const s = { ...DEFAULT_STYLE.selection, ...this.style.selection };
    return { widthScale: s.widthScale ?? 2, lighten: s.lighten ?? 0.45 };
  }

  agentRingVisual(): AgentRingVisual {
    const r = { ...DEFAULT_STYLE.agentRings, ...this.style.agentRings };
    return {
      show: r.show ?? true,
      color: r.color ?? "warning",
      width: r.width ?? 4,
      innerScale: r.innerScale ?? 1.35,
      spacing: r.spacing ?? 0.3,
      rotateDegPerSec: r.rotateDegPerSec ?? 45,
      spokeScale: r.spokeScale ?? 1.1,
      spokeTipScale: r.spokeTipScale ?? 0.45,
      spokeLaneGap: r.spokeLaneGap ?? 0.12,
      minRadiusPx: r.minRadiusPx ?? 16,
      spokeLighten: r.spokeLighten ?? 0.35,
    };
  }
}
