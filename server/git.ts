import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface ListBranchesInput {
  repoRoot: string;
}

export interface BranchEntry {
  name: string;
  headSha: string;
  /** Absolute path of the worktree that has this branch checked out, if any. */
  worktreePath: string | null;
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
  error: string | null;
}

/** Lists local branches of the repo at `repoRoot` and which worktree (if any) has each checked out. */
export async function listBranches({ repoRoot }: ListBranchesInput): Promise<ListBranchesResult> {
  let branchText: string;
  let worktreeText: string;
  try {
    [branchText, worktreeText] = await Promise.all([
      runGit(repoRoot, ["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(objectname)"]),
      runGit(repoRoot, ["worktree", "list", "--porcelain"]),
    ]);
  } catch (err) {
    return { branches: null, worktrees: [], error: describeGitError(err) };
  }
  const worktrees = parseWorktreeList(worktreeText);
  const byBranch = new Map<string, string>();
  for (const worktree of worktrees) {
    if (worktree.branch !== null && !byBranch.has(worktree.branch)) byBranch.set(worktree.branch, worktree.path);
  }
  const branches = parseBranches(branchText).map((branch) => ({
    ...branch,
    worktreePath: byBranch.get(branch.name) ?? null,
  }));
  return { branches, worktrees, error: null };
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

function describeGitError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if ("stderr" in err && typeof err.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
    if ("killed" in err && err.killed === true) return `git timed out after ${GIT_TIMEOUT_MS}ms`;
  }
  return err instanceof Error ? err.message : String(err);
}
