import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Client → daemon: report what the renderer managed to initialise, so it shows in `paseo plugin logs`. */
export const rendererReportRpc = defineRpc({
  name: "leyline.renderer.report",
  input: z.object({
    surface: z.enum(["hub", "workspace"]),
    ok: z.boolean(),
    detail: z.string(),
  }),
  output: z.object({ received: z.literal(true) }),
});

/** Daemon reads `<workspace directory>/.leyline/style.json`; `style` is null when absent, `error` when invalid. */
export const loadStyleRpc = defineRpc({
  name: "leyline.style.load",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({
    path: z.string().nullable(),
    style: z.unknown().nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * Daemon runs `git` in a repo root to list local branches and which worktree (if any) has each checked out.
 * Paseo only reports the current branch per workspace; everything else about local refs comes from here.
 */
export const listBranchesRpc = defineRpc({
  name: "leyline.git.branches",
  input: z.object({ repoRoot: z.string() }),
  output: z.object({
    /** Null when `repoRoot` is not a git repository or git failed; `error` explains. */
    branches: z
      .array(
        z.object({
          name: z.string(),
          headSha: z.string(),
          /** Absolute path of the worktree that has this branch checked out, if any. */
          worktreePath: z.string().nullable(),
          /**
           * Branch this one was branched from: git config `branch.<name>.leylinebase` (or a local
           * `branch.<name>.merge` upstream) when set, otherwise inferred from the fork point.
           */
          base: z
            .object({
              name: z.string(),
              via: z.enum(["config", "inferred"]),
              commitsAhead: z.number().int().nonnegative(),
            })
            .nullable(),
        }),
      )
      .nullable(),
    /** Worktrees known to git (`git worktree list`), including the main checkout. */
    worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable(), headSha: z.string() })),
    /** `origin/HEAD` target, else `main`/`master` if present, else null. */
    defaultBranch: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
