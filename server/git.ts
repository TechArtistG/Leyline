import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface ListBranchesInput {
  repoRoot: string;
}

export interface BranchBase {
  name: string;
  via: "config" | "inferred";
  commitsAhead: number;
}

export interface BranchEntry {
  name: string;
  headSha: string;
  /** Absolute path of the worktree that has this branch checked out, if any. */
  worktreePath: string | null;
  /** Branch this one was based on (config or inferred from the DAG); null when unknown. */
  base: BranchBase | null;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  headSha: string;
}

export interface ListBranchesResult {
  /** Null when `repoRoot` is not a git repository or git failed; `error` explains. */
  branches: BranchEntry[] | null;
  worktrees: WorktreeEntry[];
  /** `origin/HEAD` target, else `main`/`master` if present, else null. */
  defaultBranch: string | null;
  error: string | null;
}

/** Upper bound on commits loaded for base inference; branches forked further back get `base: null`. */
const REV_LIST_MAX_COUNT = 40_000;

/** Lists local branches of the repo at `repoRoot`, which worktree has each checked out, and what each was based on. */
export async function listBranches({ repoRoot }: ListBranchesInput): Promise<ListBranchesResult> {
  let branchText: string;
  let worktreeText: string;
  let configText: string;
  let originHead: string;
  try {
    [branchText, worktreeText, configText, originHead] = await Promise.all([
      runGit(repoRoot, ["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(objectname)"]),
      runGit(repoRoot, ["worktree", "list", "--porcelain"]),
      runGitOrEmpty(repoRoot, ["config", "--get-regexp", "^branch\\."]),
      runGitOrEmpty(repoRoot, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]),
    ]);
  } catch (err) {
    return { branches: null, worktrees: [], defaultBranch: null, error: describeGitError(err) };
  }
  const worktrees = parseWorktreeList(worktreeText);
  const byBranch = new Map<string, string>();
  for (const worktree of worktrees) {
    if (worktree.branch !== null && !byBranch.has(worktree.branch)) byBranch.set(worktree.branch, worktree.path);
  }
  const heads = parseBranches(branchText);
  const tips = new Map(heads.map((branch) => [branch.name, branch.headSha]));
  const defaultBranch = resolveDefaultBranch(originHead, tips);
  const configured = parseConfiguredBases(configText);

  let graph: CommitGraph | null = null;
  if (heads.length > 0) {
    try {
      const revList = await runGit(repoRoot, [
        "rev-list",
        "--topo-order",
        "--parents",
        "--branches",
        `--max-count=${REV_LIST_MAX_COUNT}`,
      ]);
      graph = buildCommitGraph(revList, tips);
    } catch (err) {
      console.warn(`[leyline] rev-list failed in ${repoRoot}: ${describeGitError(err)}`);
    }
  }

  const branches: BranchEntry[] = [];
  for (const head of heads) {
    const worktreePath = byBranch.get(head.name) ?? null;
    let base: BranchBase | null = null;
    const configuredBase = configured.get(head.name);
    if (configuredBase !== undefined && configuredBase !== head.name) {
      let commitsAhead = graph === null ? null : countAhead(graph, head.name, configuredBase);
      if (commitsAhead === null) commitsAhead = await countAheadViaGit(repoRoot, head.name, configuredBase);
      if (commitsAhead !== null) base = { name: configuredBase, via: "config", commitsAhead };
    }
    if (base === null && graph !== null) {
      const inferred = inferBase(graph, head.name, defaultBranch);
      if (inferred !== null) base = { ...inferred, via: "inferred" };
    }
    branches.push({ ...head, worktreePath, base });
  }
  return { branches, worktrees, defaultBranch, error: null };
}

/** Records `branch.<branch>.leylinebase` in the repo containing `worktreePath`. */
export async function setBranchBase(worktreePath: string, branch: string, base: string): Promise<void> {
  await runGit(worktreePath, ["config", `branch.${branch}.leylinebase`, base]);
}

/** `refs/heads/x`, `refs/remotes/origin/x` and `origin/x` → `x`. */
export function stripRefPrefix(ref: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/origin/", "origin/"]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

function resolveDefaultBranch(originHead: string, tips: Map<string, string>): string | null {
  const target = originHead.trim();
  if (target) return target.startsWith("origin/") ? target.slice("origin/".length) : target;
  for (const candidate of ["main", "master"]) if (tips.has(candidate)) return candidate;
  return null;
}

/**
 * Parses `git config --get-regexp '^branch\.'` output into `branch → base`.
 * `branch.<name>.leylinebase` wins; otherwise a local upstream (`remote = .` with `merge = refs/heads/<base>`).
 */
export function parseConfiguredBases(text: string): Map<string, string> {
  const leyline = new Map<string, string>();
  const remote = new Map<string, string>();
  const merge = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("branch.")) continue;
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1).trim();
    const dot = key.lastIndexOf(".");
    if (dot <= "branch.".length) continue;
    const name = key.slice("branch.".length, dot);
    const sub = key.slice(dot + 1);
    if (sub === "leylinebase") leyline.set(name, value);
    else if (sub === "remote") remote.set(name, value);
    else if (sub === "merge") merge.set(name, value);
  }
  const bases = new Map<string, string>();
  for (const [name, upstream] of merge) {
    if (remote.get(name) === "." && upstream.startsWith("refs/heads/")) bases.set(name, stripRefsHeads(upstream));
  }
  for (const [name, base] of leyline) if (base) bases.set(name, base);
  return bases;
}

/**
 * Reachability over the commits of `git rev-list --topo-order --parents --branches`.
 * `contains[sha]` is a bitset over branch indices: bit `i` is set when `names[i]`'s tip reaches `sha`.
 */
export interface CommitGraph {
  /** Branch names sorted; index is the bit position. */
  names: string[];
  index: Map<string, number>;
  tips: Map<string, string>;
  words: number;
  contains: Map<string, Uint32Array>;
  firstParent: Map<string, string | null>;
}

export function buildCommitGraph(revListText: string, tips: Map<string, string>): CommitGraph {
  const names = [...tips.keys()].sort();
  const index = new Map(names.map((name, i) => [name, i]));
  const words = Math.max(1, Math.ceil(names.length / 32));
  const tipBits = new Map<string, Uint32Array>();
  for (const [name, sha] of tips) {
    let bits = tipBits.get(sha);
    if (!bits) tipBits.set(sha, (bits = new Uint32Array(words)));
    const i = index.get(name)!;
    bits[i >>> 5] |= 1 << (i & 31);
  }
  const contains = new Map<string, Uint32Array>();
  const firstParent = new Map<string, string | null>();
  const lines = revListText.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(" ");
    const sha = parts[0];
    let bits = contains.get(sha);
    if (!bits) contains.set(sha, (bits = new Uint32Array(words)));
    const own = tipBits.get(sha);
    if (own) for (let w = 0; w < words; w++) bits[w] |= own[w];
    firstParent.set(sha, parts.length > 1 ? parts[1] : null);
    for (let p = 1; p < parts.length; p++) {
      const parent = parts[p];
      let parentBits = contains.get(parent);
      if (!parentBits) contains.set(parent, (parentBits = new Uint32Array(words)));
      for (let w = 0; w < words; w++) parentBits[w] |= bits[w];
    }
  }
  return { names, index, tips, words, contains, firstParent };
}

/**
 * Infers the branch `name` was forked from: walks first-parent from its tip until a commit is reached that
 * some other branch contains, excluding branches that already contain `name`'s tip (it was merged into them).
 * Ties prefer a branch whose tip is that commit, then `defaultBranch`, then the alphabetically first.
 */
export function inferBase(
  graph: CommitGraph,
  name: string,
  defaultBranch: string | null,
): { name: string; commitsAhead: number } | null {
  if (name === defaultBranch) return null;
  const tip = graph.tips.get(name);
  if (tip === undefined) return null;
  const containers = graph.contains.get(tip);
  if (!containers) return null;
  const self = graph.index.get(name)!;
  const defaultIndex = defaultBranch === null ? undefined : graph.index.get(defaultBranch);
  const { words } = graph;
  let sha: string | null = tip;
  for (let steps = 0; sha !== null; steps++) {
    const bits = graph.contains.get(sha);
    if (!bits) return null;
    let chosen = -1;
    let fallback = -1;
    for (let w = 0; w < words && chosen < 0; w++) {
      let candidates = bits[w] & ~containers[w];
      if (w === self >>> 5) candidates &= ~(1 << (self & 31));
      while (candidates !== 0) {
        const low = candidates & -candidates;
        const i = (w << 5) + (31 - Math.clz32(low));
        candidates &= ~low;
        if (graph.tips.get(graph.names[i]) === sha) {
          chosen = i;
          break;
        }
        if (i === defaultIndex) fallback = i;
        else if (fallback < 0) fallback = i;
      }
    }
    if (chosen < 0 && fallback >= 0) chosen = fallback;
    if (chosen >= 0) return { name: graph.names[chosen], commitsAhead: steps };
    sha = graph.firstParent.get(sha) ?? null;
  }
  return null;
}

/** First-parent steps from `name`'s tip to the first commit `base` contains; null when `base` is unknown or the walk exhausts. */
export function countAhead(graph: CommitGraph, name: string, base: string): number | null {
  const baseIndex = graph.index.get(base);
  const tip = graph.tips.get(name);
  if (baseIndex === undefined || tip === undefined) return null;
  const word = baseIndex >>> 5;
  const mask = 1 << (baseIndex & 31);
  let sha: string | null = tip;
  for (let steps = 0; sha !== null; steps++) {
    const bits = graph.contains.get(sha);
    if (!bits) return null;
    if ((bits[word] & mask) !== 0) return steps;
    sha = graph.firstParent.get(sha) ?? null;
  }
  return null;
}

/** Pure composition of `buildCommitGraph` + `inferBase` for every branch; absent entries mean no base. */
export function inferBases(
  revListText: string,
  tips: Map<string, string>,
  defaultBranch: string | null,
): Map<string, { name: string; commitsAhead: number }> {
  const graph = buildCommitGraph(revListText, tips);
  const bases = new Map<string, { name: string; commitsAhead: number }>();
  for (const name of graph.names) {
    const base = inferBase(graph, name, defaultBranch);
    if (base !== null) bases.set(name, base);
  }
  return bases;
}

async function countAheadViaGit(repoRoot: string, name: string, base: string): Promise<number | null> {
  try {
    const count = Number.parseInt((await runGit(repoRoot, ["rev-list", "--count", `${base}..${name}`])).trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/** Parses `git for-each-ref refs/heads --format=%(refname:short)%00%(objectname)` output. */
export function parseBranches(text: string): Array<{ name: string; headSha: string }> {
  const branches: Array<{ name: string; headSha: string }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("\0");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const headSha = line.slice(separator + 1).trim();
    if (name && headSha) branches.push({ name, headSha });
  }
  return branches;
}

/** Parses `git worktree list --porcelain` output; paths are normalised with `path.resolve`. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const worktrees: WorktreeEntry[] = [];
  let current: { path: string; branch: string | null; headSha: string } | null = null;
  const flush = () => {
    if (current && current.path) worktrees.push(current);
    current = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: resolve(line.slice("worktree ".length).trim()), branch: null, headSha: "" };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = stripRefsHeads(line.slice("branch ".length).trim());
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  flush();
  return worktrees;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Like `runGit`, but a non-zero exit with empty stderr (e.g. `config --get-regexp` with no matches) yields "". */
async function runGitOrEmpty(repoRoot: string, args: string[]): Promise<string> {
  try {
    return await runGit(repoRoot, args);
  } catch (err) {
    if (typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string" && !err.stderr.trim()) {
      return "";
    }
    throw err;
  }
}

function describeGitError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if ("stderr" in err && typeof err.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
    if ("killed" in err && err.killed === true) return `git timed out after ${GIT_TIMEOUT_MS}ms`;
  }
  return err instanceof Error ? err.message : String(err);
}
