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
}

export interface ConnectorVisual {
  color: ColorRef;
  /** 0..1. */
  opacity: number;
  dashed: boolean;
  /** Draw an arrowhead at the target. */
  directed: boolean;
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
