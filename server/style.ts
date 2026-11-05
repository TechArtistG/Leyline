import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { parseGraphStyle } from "../shared/model/style";
import type { GraphStyle } from "../shared/model/style";

export const STYLE_RELATIVE_PATH = join(".leyline", "style.json");

export interface LoadStyleInput {
  workspaceId?: string;
}

export interface LoadStyleResult {
  /** Absolute path that was (or would be) read; null when the workspace is unknown. */
  path: string | null;
  style: GraphStyle | null;
  error: string | null;
}

/** Resolves the workspace directory via Paseo and reads `<dir>/.leyline/style.json`. */
export async function loadStyle(input: LoadStyleInput, paseo: PaseoApi): Promise<LoadStyleResult> {
  const directory = await resolveWorkspaceDirectory(input.workspaceId, paseo);
  if (!directory) return { path: null, style: null, error: null };
  return loadStyleFile(join(directory, STYLE_RELATIVE_PATH));
}

/** Reads and validates a style file. Missing file → `style: null, error: null`; invalid → `error`. */
export async function loadStyleFile(path: string): Promise<LoadStyleResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return { path, style: null, error: null };
    return { path, style: null, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { path, style: parseGraphStyle(JSON.parse(text)), error: null };
  } catch (err) {
    const message = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
    return { path, style: null, error: message };
  }
}

async function resolveWorkspaceDirectory(workspaceId: string | undefined, paseo: PaseoApi): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    return workspace?.workspaceDirectory ?? null;
  } catch {
    return null;
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}
