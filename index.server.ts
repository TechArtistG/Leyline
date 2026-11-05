import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolve } from "node:path";
import { listBranchesRpc, loadStyleRpc, rendererReportRpc } from "./shared/contracts";
import { listBranches, setBranchBase, stripRefPrefix } from "./server/git";
import { loadStyle } from "./server/style";

/** `worktree.create.before` requests carrying a `baseRef`, awaiting their `after` event (keyed by path and branch). */
const pendingBases: Array<{ path: string; branch: string; baseRef: string }> = [];

export default function contribute(server: PluginServerContext) {
  server.handle(rendererReportRpc, ({ surface, ok, detail }) => {
    console.log(`[leyline] renderer ${ok ? "ok" : "FAILED"} (${surface}): ${detail}`);
    return { received: true as const };
  });
  server.handle(loadStyleRpc, (input, { paseo }) => loadStyle(input, paseo));
  server.handle(listBranchesRpc, (input) => listBranches(input));

  const offBefore = server.addHook("worktree.create.before", async ({ request }) => {
    if (!("baseRef" in request) || !request.baseRef) return;
    pendingBases.push({ path: resolve(request.path), branch: request.branch, baseRef: request.baseRef });
  });
  const offAfter = server.addHook("worktree.create.after", async ({ worktree }) => {
    const path = resolve(worktree.path);
    const at = pendingBases.findIndex((entry) => entry.path === path || entry.branch === worktree.branch);
    if (at < 0) return;
    const [{ baseRef }] = pendingBases.splice(at, 1);
    const base = stripRefPrefix(baseRef);
    if (!base || base === worktree.branch) return;
    try {
      await setBranchBase(worktree.path, worktree.branch, base);
    } catch (err) {
      console.warn(`[leyline] could not record base ${base} for ${worktree.branch}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return () => {
    offBefore();
    offAfter();
    pendingBases.length = 0;
  };
}
