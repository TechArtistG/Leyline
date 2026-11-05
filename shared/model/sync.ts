/** Internal helpers shared by the node/connector subclasses; not part of the barrel. */

/**
 * Copy `keys` from `data` onto `target` when they differ (strict equality).
 * Returns whether any key changed.
 */
export function syncFields<T, K extends keyof T>(target: T, data: { [P in K]?: T[P] }, keys: readonly K[]): boolean {
  let changed = false;
  for (const key of keys) {
    if (target[key] !== data[key]) {
      target[key] = data[key] as T[K];
      changed = true;
    }
  }
  return changed;
}

/** Drop `undefined`-valued keys so serialised data round-trips equal to its wire input. */
export function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
