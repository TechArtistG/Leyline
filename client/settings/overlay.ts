import type { GraphStyle } from "../../shared/model/style";
import type { LeylineSettings } from "../../shared/settings";

/**
 * The part of the look that the user's global settings decide. Layered over the built-in and the
 * project's `.leyline/style.json` with `mergeStyles`, so a project style keeps its colours while the
 * user's display toggles still win.
 */
export function settingsStyleOverlay(values: LeylineSettings): GraphStyle {
  return {
    clusters: { show: values.showClusters },
    agentRings: { show: values.showAgentRings },
    nodes: { file: { hidden: !values.showFiles } },
    labels: { fontSizePx: values.labelFontSizePx, maxFontSizePx: values.labelMaxFontSizePx },
  };
}

type RuleMap = Record<string, { states?: Record<string, object> }>;

/** Merges keyed rule maps (`nodes`, `connectors`): per kind, props shallow, `states` one level deeper. */
function mergeRules<M extends RuleMap>(base: M | undefined, over: M | undefined): M | undefined {
  if (!over) return base;
  if (!base) return over;
  const out: RuleMap = { ...base };
  for (const [kind, rule] of Object.entries(over)) {
    const prev = out[kind];
    if (!prev) {
      out[kind] = rule;
      continue;
    }
    const merged: RuleMap[string] = { ...prev, ...rule };
    if (prev.states && rule.states) {
      const states: Record<string, object> = { ...prev.states };
      for (const [state, style] of Object.entries(rule.states)) {
        states[state] = { ...states[state], ...style };
      }
      merged.states = states;
    }
    out[kind] = merged;
  }
  return out as M;
}

/**
 * Later overlays win. Each top-level section is merged one level deep (`labels.lod` shallow-merged
 * too); `nodes`/`connectors` merge per kind with `states` merged one level deeper. Inputs are not mutated.
 */
export function mergeStyles(base: GraphStyle, ...overlays: GraphStyle[]): GraphStyle {
  let out: GraphStyle = { ...base };
  for (const over of overlays) {
    const next: GraphStyle = { ...out };
    if (over.palette) next.palette = { ...out.palette, ...over.palette };
    if (over.nodes) next.nodes = mergeRules(out.nodes, over.nodes);
    if (over.connectors) next.connectors = mergeRules(out.connectors, over.connectors);
    if (over.labels) {
      next.labels = { ...out.labels, ...over.labels };
      if (out.labels?.lod && over.labels.lod) next.labels.lod = { ...out.labels.lod, ...over.labels.lod };
    }
    if (over.clusters) next.clusters = { ...out.clusters, ...over.clusters };
    if (over.selection) next.selection = { ...out.selection, ...over.selection };
    if (over.agentRings) next.agentRings = { ...out.agentRings, ...over.agentRings };
    out = next;
  }
  return out;
}
