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
}

export interface ConnectorVisual {
  color: ColorRef;
  /** 0..1. */
  opacity: number;
  dashed: boolean;
  /** Draw an arrowhead at the target. */
  directed: boolean;
}
