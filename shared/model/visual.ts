/** Theme-independent visual roles, or a literal `#rrggbb` from a style. The renderer maps roles to `PluginTheme` colours. */
export type ColorRole = "accent" | "success" | "warning" | "danger" | "muted" | "foreground" | "border";
export type ColorRef = ColorRole | `#${string}`;

export interface NodeVisual {
  /** World-unit radius (kind default × node weight × style size). */
  radius: number;
  color: ColorRef;
  /** 0..1 emissive intensity. */
  emissive: number;
  /** Slow scale pulse (active work). */
  pulse: boolean;
  /** Optional ring around the node (integration targets, attention). */
  ring?: ColorRef;
  /** Show the label without hover/select. */
  labelAlways: boolean;
  /** Screen-space side of the node the label sits on. */
  labelAnchor: "above" | "below" | "left" | "right";
  /** `project` labels survive zooming out; `all` labels need the zoom LOD threshold. */
  labelTier: "project" | "all";
  /** Not drawn and not simulated; incident connectors are hidden too. */
  hidden: boolean;
  /** 0..1 mix of `color` toward foreground. */
  lighten: number;
}

export interface ConnectorVisual {
  /** Screen-space line width in px. */
  width: number;
  color: ColorRef;
  /** 0..1. */
  opacity: number;
  dashed: boolean;
  /** Draw an arrowhead at the target. */
  directed: boolean;
  /** 1 or 2 parallel lines; two lanes march in opposite directions. */
  lanes: 1 | 2;
  /** Dash march speed in world units/s; 0 = static. */
  marchSpeed: number;
}

/** Resolved global label behaviour (screen-space sizing, anchoring, zoom LOD). */
export interface LabelSettings {
  /** Base screen-space size; never rendered smaller. */
  fontSizePx: number;
  /** Upper bound as zoom increases. */
  maxFontSizePx: number;
  color: ColorRef;
  anchor: "above" | "below" | "left" | "right";
  /** Gap between node silhouette and label, in px. */
  offsetPx: number;
  /** Pixels per world unit below which only `project`-tier labels show. */
  allAbovePxPerUnit: number;
  /** Pixels per world unit at which labels are exactly `fontSizePx`. */
  referencePxPerUnit: number;
}

/** Rings around a worktree, one per anchored agent; dashed + rotating while that agent executes. */
export interface AgentRingVisual {
  show: boolean;
  color: ColorRef;
  width: number;
  innerScale: number;
  spacing: number;
  rotateDegPerSec: number;
}
