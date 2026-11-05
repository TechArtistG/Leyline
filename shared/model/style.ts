import { z } from "zod";
import type { Connector } from "./connector";
import type { GraphNode } from "./node";
import type { ColorRef, ConnectorVisual, NodeVisual } from "./visual";
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

const NodeStyle = z.object({
  /** Multiplier on the kind's default radius. */
  size: z.number().positive().optional(),
  color: ColorRefSchema.optional(),
  emissive: z.number().min(0).max(1).optional(),
  pulse: z.boolean().optional(),
  ring: ColorRefSchema.nullable().optional(),
  labelAlways: z.boolean().optional(),
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
      fontSizePx: z.number().positive().optional(),
      color: ColorRefSchema.optional(),
    })
    .optional(),
});
export type GraphStyle = z.infer<typeof GraphStyle>;

export const DEFAULT_STYLE: GraphStyle = {
  nodes: {
    universe: { color: "border", emissive: 0.2, labelAlways: true },
    host: { color: "muted", labelAlways: true },
    repo: { color: "muted", labelAlways: true },
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
    file: { color: "foreground" },
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
  labels: { fontSizePx: 13, color: "foreground" },
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

  labelFontSizePx(): number {
    return this.style.labels?.fontSizePx ?? DEFAULT_STYLE.labels?.fontSizePx ?? 13;
  }

  labelColor(): ColorRef {
    return this.style.labels?.color ?? "foreground";
  }
}
