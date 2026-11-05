import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { GRAPH_MODES } from "./graph";

/**
 * Global (per Paseo host) user preferences. Persisted by Paseo's settings store; edited from the
 * Leyline settings screen (Settings → Plugins) and the cog in the graph viewport.
 * These are UI preferences layered over the project's `.leyline/style.json` look.
 */
export const LeylineSettingsSchema = z.object({
  /** Layout mode a new graph viewport opens in. */
  defaultMode: z.enum(GRAPH_MODES).default("3d-hub"),
  /** Draw the per-project containment sphere / hull. */
  showClusters: z.boolean().default(true),
  /** Draw agent rings around worktrees. */
  showAgentRings: z.boolean().default(true),
  /** Show `file` nodes (hidden by default; branches are the finest granularity). */
  showFiles: z.boolean().default(false),
  /** Include git worktrees that are not Paseo workspaces. */
  showGitOnlyWorktrees: z.boolean().default(true),
  /** Include local branches that are not checked out in any worktree. */
  showOtherBranches: z.boolean().default(true),
  /** Attach repos directly to the universe node instead of per-host nodes. */
  collapseHosts: z.boolean().default(false),
  /** Base label size in px; labels grow with zoom up to `labelMaxFontSizePx`. */
  labelFontSizePx: z.number().int().min(8).max(32).default(13),
  labelMaxFontSizePx: z.number().int().min(8).max(64).default(22),
  /** How often the daemon re-reads git branches/worktrees per repo. */
  gitRefreshSeconds: z.number().int().min(3).max(300).default(15),
});
export type LeylineSettings = z.infer<typeof LeylineSettingsSchema>;

export const LEYLINE_SETTINGS_DEFAULTS: LeylineSettings = LeylineSettingsSchema.parse({});

export const leylineSettings = defineSettings({
  id: "leyline",
  scope: "host",
  version: 1,
  schema: LeylineSettingsSchema,
});
