# Leyline design notes

Living document. Architecture decisions with alternatives go in `docs/ADR-*.md`; this file holds the domain model.

## Graph model

**Git is the spiderweb; agents are the spiders that crawl along it.**

Two layers, declared per node kind (`KIND_LAYER` in `shared/model/node.ts`):

| Layer | Kinds | Laid out by |
|---|---|---|
| `web` | `universe`, `host`, `repo`, `branch`, `worktree`, `file`, `pr` | The force simulation. Stable; agents never perturb it. |
| `spider` | `agent`, `subagent` | Their `anchorId` (agent → worktree, subagent → parent agent): placed on a ring around the anchor, tweened along the web when the anchor changes. |

Roots: `universe` is the abstract root everything hangs off; each Paseo daemon is a `host` beneath it. A later view setting will offer `roots: "hosts"` (universe → host → repo) or `roots: "universe"` (hosts collapsed).

### Topology builder

`client/topology/builder.ts` (`startTopology`) runs where `usePaseo()` lives, so no daemon stream is needed. It mirrors four Paseo sources into plain maps — `workspaces.list({ subscribe })`, `agents.list({ subscribe })`, `projects.list()` + `projects.subscribe`, and `observeEvents(["agent.provider_subagents.update", "project.update"])` — plus per-repo git data from `listBranchesRpc` (fetched on first sight of a repo, every 15 s, and immediately when a workspace's `currentBranch` changes or a workspace appears). Any change schedules one coalesced `recompute()` that derives the whole desired node/connector set in O(n) and applies `{ upsert all, remove previously-emitted − desired }` through `Graph.applyPatch`, which drops no-op updates.

Ids: `universe`, `host:<hostId>`, `repo:<projectId>`, `wt:<workspaceId>`, `wt:git:<projectId>/<basename>` (git worktree Paseo does not manage; `#<index>` appended on basename collisions), `branch:<projectId>/<name>`, `agent:<agentId>`, `sub:<subagentId>`; connectors `<kind>:<source>-><target>`, always parent → child.

- **Repos**: every project in `projects.list()` or owning a visible (non-archived, non-internal) workspace.
- **Worktrees**: the union of Paseo workspaces and `git worktree list`, matched by normalised path (forward slashes, lowercase drive letter, no trailing slash). Matched or Paseo-only worktrees carry Paseo's dirty / ahead / behind / status / diffStat at weight 1; git-only worktrees are weight 0.7 with zeroed git stats.
- **Branches**: the branch checked out in a worktree hangs off it (`contains`, weight 1); every other local branch hangs off the repo (`branch-of`, weight 0.6). A branch name is never a node twice.
- **Agents**: non-archived, non-closed agents attach to `wt:<workspaceId>`, falling back to a cwd path match; state is `error` → `error`, `requiresAttention` → `attention`, `running` → `executing`, else `idle`. Subagents only exist as events arrive and are dropped once their parent agent disappears.
- **Scope**: `scope.workspaceId` narrows the graph to that workspace's project (the workspace panel); the hub is unscoped.

Lifetime: `stop()` clears the recompute and poll timers, runs every observer unsubscribe, then calls `release()` on every `OwnedSubscription` it acquired (workspaces, agents, events). Subscriptions that resolve after `stop()` are released on arrival, so a surface unmounting mid-connect leaks nothing. `GraphView` keeps one `Graph` per component and runs the builder in an effect keyed by host / scope / data source; the Live ↔ Mock toggle stops the builder, empties the model, and either applies the fixture or restarts it.

### Wire vs model

- **Wire** (`shared/model/wire.ts`): Zod discriminated unions per kind — `NodeData`, `ConnectorData`, `GraphPatch { upsertNodes, removeNodes, upsertConnectors, removeConnectors }`. This is what the daemon streams; it never carries class instances.
- **Model** (`shared/model/`): `GraphNode<K>` and `Connector<K>` base classes with one subclass per kind (`nodes.ts`, `connectors.ts`, `factory.ts`). Instances are the in-memory truth on both sides, hydrated by `Graph.applyPatch`, mutated only through `update(data)` which bumps `revision` when something observable changed. `Graph` holds adjacency, cascades node removal to incident connectors, drops connectors with missing endpoints, and emits one batched `GraphChange[]` per patch to subscribers.
- **Renderer contract** (`shared/graph.ts`): `GraphHandle { graph, setMode, setStyle, relayout, fit, on, destroy }` and the three layout modes (`2d-lr`, `2d-hub`, `3d-hub`). The renderer subscribes to the `Graph`; it owns no node data.

Tree connectors (`TREE_CONNECTOR_KINDS`: `contains`, `spawned`, `branch-of`, `touches`, `merges-into`) define depth for the layered layout; `shares-context` is a pure cross-link.

### Containment

Every project is spatially contained: each web node belongs to one **cluster** — the nearest `repo` reached by walking incoming tree connectors (except `merges-into`; a node with no tree parent, such as a PR, continues through its `group`), or `root` for `universe`/`host`. Spiders take their anchor's cluster; hidden nodes belong to none. `client/renderer/clusters.ts` supplies two forces: `forceCluster` pulls hub-mode members toward their centroid, and `forceClusterCollide` measures each cluster's padded bounding circle/sphere (y-interval in `2d-lr`, where each cluster is also held in its own y band) and pushes clusters apart whenever they come within `CLUSTER_GAP` of touching, with `root` as a fixed obstacle. The hull drawn around each repo cluster (convex hull of padded node circles in 2D, translucent bounding sphere in 3D — the sphere is the chosen 3D grouping signifier, not a hull mesh) is styled by `clusters` in `GraphStyle`; `handle.__debug.clusterOverlaps()` counts intersecting cluster pairs (0 once settled).

### Style

The look is data, not code. Each node/connector exposes a semantic `styleState` (agent → its state, worktree → `integration` / `dirty`, pr → its state, `merges-into` → `included` / `stale` / `conflicts`, `touches` → `read` / `edit` / `write`); a `GraphStyle` (`shared/model/style.ts`) maps `kind` base rules plus per-state overrides to theme-independent visuals (`NodeVisual`, `ConnectorVisual`). Colours are roles (`accent`, `success`, …) resolved against the Paseo theme, overridable per role via `palette`, or literal hex. `DEFAULT_STYLE` is built in; a project overrides it with `.leyline/style.json` (loaded by the daemon via `loadStyleRpc`, validated, errors surfaced in the panel status line). See `docs/style.example.json`.

## Integration branches

### Problem

With several agents on separate feature branches, their work must be tested together before any PR exists. Neither git nor Paseo has a first-class "merge these branches into that one for testing" relationship: git's `branch.<name>.merge` is one-to-one upstream tracking, merge history records the past, and Paseo's `pullRequest.baseRefName` only exists once a PR does.

### Model

An **integration branch** is a *rebuildable temporary proxy for `main`*: derived state, never authored, with none of the PR/CI/review gates.

```
integration/<name>  =  <base>  +  merge(sources[0])  +  merge(sources[1])  +  …
```

- Leyline owns the branch. Nobody commits to it directly.
- **Rebuild**, not sync: whenever a source or the base moves, the branch is recreated from scratch (`git checkout -B <target> <base>`, then `git merge --no-ff` each source in order). No drift, no stale merge commits, tracks `main` automatically.
- **Conflicts** survive rebuilds via `git rerere`: the first time a merge conflicts, an agent (or the user) resolves it once in the integration worktree; `rr-cache` replays the resolution on every later rebuild. Resolutions are clone-local, which is acceptable for a disposable branch.
- Test agents are spawned *in* the integration worktree (`workspace.agents.create({ prompt })`) — "test the full feature arc" is a graph action, not a PR.

### Manifest

Versioned in the repo so every worktree, clone, and agent sees the same declaration:

```json
// .leyline/integrations.json
{
  "integrations": [
    {
      "target": "integration/kitbash",
      "base": "main",
      "sources": ["feature/kitbash-review-rig", "feature/force-layout"],
      "rebuild": "on-change",
      "purpose": "Full feature-arc test before PRs"
    }
  ]
}
```

- Branch names only; Leyline locates or creates the worktree hosting `target` at runtime (`workspaces.create({ source: { kind: "worktree", action: "checkout" } })`), keeping the file machine-independent.
- `sources` order is the merge order.
- `rebuild`: `on-change` (rebuild when a source worktree's agent turn ends via `agent.turn.after`, or when `base` advances) or `manual`.

### Derived state (read-only git, computed server-side)

| State | How |
|---|---|
| source `included` | `git merge-base --is-ancestor <source> <target>` |
| source `stale` | source head moved since the last rebuild recorded for the target |
| source `conflicts` | `git merge-tree --write-tree <target> <source>` (git ≥ 2.38) reports conflicts without touching a worktree and no `rerere` resolution matches |
| target `base moved` | `git merge-base --is-ancestor <base> <target>` is false |

### Graph mapping

- The target is a `worktree` node with a distinct ring; each source worktree has a `merges-into` edge coloured by state (`included` success, `stale` warning, `conflicts` danger).
- In `2d-lr`, `merges-into` counts as a tree edge for depth so the integration target sits one column right of its sources.
- Actions on the target node: Rebuild, Spawn test agent, Open diff vs base.

### Agent tools

`defineAgentTool` (registered in `agent.open.before`) gives every agent:

- `leyline_merge_into_integration({ source })` — refuses sources not declared in the manifest; triggers a rebuild and returns the per-source state.
- `leyline_request_context({ agentId })` — summary of another agent's recent timeline and touched files; recorded as a `shares-context` edge.

## Branch bases

Git has no first-class "branched from" relation, so Leyline derives it from two sources, explicit first:

1. **Config** — `branch.<name>.leylinebase` (Leyline's own key) or a local upstream (`branch.<name>.remote = .` + `branch.<name>.merge`). The daemon records `leylinebase` from Paseo's `worktree.create.before/after` hooks whenever a worktree is branched off, so anything created through Paseo is exact.
2. **Inferred** — one `git rev-list --topo-order --parents --branches` dump; a single topo pass propagates per-commit branch-containment bitsets child→parent; for each branch, walk first-parent from the tip until a commit contained by another branch that does not itself contain this tip (excludes branches this one was merged into). Tie-break: a branch whose tip is that commit, then the default branch, then name order. `commitsAhead` = steps walked.

The default branch (`origin/HEAD`, else `main`/`master`) has no base and hangs off the repo (`branch-of`); every other branch with a known base hangs off its base via a `base-of` connector (source = base, target = derived; a tree edge, so layered depth follows lineage; dashed when `via: "inferred"`). Branches with no resolvable base keep the `branch-of` edge from the repo. Checked-out branches additionally keep `contains` from their worktree.
