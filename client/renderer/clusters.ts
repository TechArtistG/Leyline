import type * as D3 from "d3-force-3d";

/**
 * Project containment: every web node belongs to one cluster (its repo, or `ROOT_CLUSTER` for the
 * universe/host above the repos). The forces here keep each cluster's members together and keep
 * clusters' bounding circles/spheres apart; the hull helper turns a cluster into an outline.
 * Pure geometry over simulation nodes; no three.js, no model types.
 */

export const ROOT_CLUSTER = "root";

/** Axes a cluster is measured and pushed along: `y` for the layered layout, else per simulation dimensions. */
export type ClusterAxes = "y" | "xy" | "xyz";

export interface ClusterNode extends D3.SimulationNode {
  radius: number;
  clusterId: string;
}

export interface Cluster<N extends ClusterNode> {
  id: string;
  /** Simulated web members: define the centroid and are the ones the forces move. */
  members: N[];
  /** Everything drawn inside the cluster (members plus the spiders riding on them): defines the extent. */
  extent: N[];
  /** Centroid of `members` as of the last `measureCluster`. */
  x: number;
  y: number;
  z: number;
  /** Bounding radius of `extent` around the centroid, including node radii and padding, along the measured axes. */
  r: number;
  /** `2d-lr`: centre y of the band the cluster is confined to. */
  bandY: number;
}

export function createCluster<N extends ClusterNode>(id: string): Cluster<N> {
  return { id, members: [], extent: [], x: 0, y: 0, z: 0, r: 0, bandY: 0 };
}

/** Recompute centroid and padded bounding radius. A cluster without placed members gets `r = 0` and is ignored by the forces. */
export function measureCluster<N extends ClusterNode>(c: Cluster<N>, padding: number, axes: ClusterAxes): void {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  for (const n of c.members) {
    if (n.x === undefined) continue;
    sx += n.x;
    sy += n.y ?? 0;
    sz += n.z ?? 0;
    count++;
  }
  if (count === 0) {
    c.r = 0;
    return;
  }
  c.x = sx / count;
  c.y = sy / count;
  c.z = sz / count;
  let r = 0;
  for (const n of c.extent) {
    if (n.x === undefined) continue;
    const dy = (n.y ?? 0) - c.y;
    let d: number;
    if (axes === "y") {
      d = Math.abs(dy);
    } else {
      const dx = n.x - c.x;
      const dz = axes === "xyz" ? (n.z ?? 0) - c.z : 0;
      d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    if (d + n.radius > r) r = d + n.radius;
  }
  c.r = r + padding;
}

/** Pull every member of a non-root cluster toward the cluster centroid, like `forceX`/`forceY` with a moving target. */
export function forceCluster<N extends ClusterNode>(
  clusters: () => readonly Cluster<N>[],
  strength: number,
  axes: ClusterAxes,
): D3.Force<N> {
  return (alpha: number) => {
    const k = strength * alpha;
    for (const c of clusters()) {
      if (c.id === ROOT_CLUSTER || c.members.length < 2) continue;
      measureCluster(c, 0, axes);
      if (c.r === 0) continue;
      for (const n of c.members) {
        if (n.x === undefined) continue;
        n.vx = (n.vx ?? 0) + (c.x - n.x) * k;
        n.vy = (n.vy ?? 0) + (c.y - (n.y ?? 0)) * k;
        if (axes === "xyz") n.vz = (n.vz ?? 0) + (c.z - (n.z ?? 0)) * k;
      }
    }
  };
}

/**
 * Clear space kept between two clusters' padded boundaries. Forces that slowly inflate a cluster
 * (charge, spider orbits) settle against this margin rather than against the boundary itself, so
 * the boundaries never touch.
 */
const CLUSTER_GAP = 1;

/**
 * Keep clusters' padded bounding circles/spheres (or y-intervals for `axes: "y"`) at least
 * `CLUSTER_GAP` apart: for each closer pair, push every member of both clusters apart along the
 * centre line, half the shortfall each. The root cluster is a fixed obstacle; repo clusters arrange
 * around it. Like d3's `forceCollide` the push ignores alpha so overlaps resolve fully even as the
 * simulation cools. Clusters must arrive sorted by id so the pass is deterministic.
 */
export function forceClusterCollide<N extends ClusterNode>(
  clusters: () => readonly Cluster<N>[],
  padding: () => number,
  strength: number,
  axes: ClusterAxes,
): D3.Force<N> {
  return () => {
    const list = clusters();
    const pad = padding();
    for (const c of list) measureCluster(c, pad, axes);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.r === 0) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.r === 0) continue;
        let dx = axes === "y" ? 0 : b.x - a.x;
        let dy = b.y - a.y;
        let dz = axes === "xyz" ? b.z - a.z : 0;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minD = a.r + b.r + CLUSTER_GAP;
        if (d >= minD) continue;
        if (d < 1e-6) {
          // Coincident centres: separate along the first available axis, later id downwards/rightwards.
          dx = axes === "y" ? 0 : 1;
          dy = axes === "y" ? 1 : 0;
          dz = 0;
          d = 1;
        }
        const push = ((minD - d) * strength) / d;
        const aShare = a.id === ROOT_CLUSTER ? 0 : b.id === ROOT_CLUSTER ? 1 : 0.5;
        const bShare = b.id === ROOT_CLUSTER ? 0 : a.id === ROOT_CLUSTER ? 1 : 0.5;
        if (aShare > 0) shift(a.members, -dx * push * aShare, -dy * push * aShare, -dz * push * aShare, axes);
        if (bShare > 0) shift(b.members, dx * push * bShare, dy * push * bShare, dz * push * bShare, axes);
      }
    }
  };
}

function shift<N extends ClusterNode>(nodes: N[], dx: number, dy: number, dz: number, axes: ClusterAxes): void {
  for (const n of nodes) {
    if (axes !== "y") n.vx = (n.vx ?? 0) + dx;
    n.vy = (n.vy ?? 0) + dy;
    if (axes === "xyz") n.vz = (n.vz ?? 0) + dz;
  }
}

/** Number of cluster pairs whose padded bounding regions intersect along `axes`; 0 once the layout is contained. */
export function countClusterOverlaps<N extends ClusterNode>(
  clusters: readonly Cluster<N>[],
  padding: number,
  axes: ClusterAxes,
): number {
  for (const c of clusters) measureCluster(c, padding, axes);
  let overlaps = 0;
  for (let i = 0; i < clusters.length; i++) {
    const a = clusters[i];
    if (a.r === 0) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      const b = clusters[j];
      if (b.r === 0) continue;
      const dx = axes === "y" ? 0 : b.x - a.x;
      const dy = b.y - a.y;
      const dz = axes === "xyz" ? b.z - a.z : 0;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < a.r + b.r - OVERLAP_EPSILON) overlaps++;
    }
  }
  return overlaps;
}
const OVERLAP_EPSILON = 1e-3;

/** Points sampled on each node's padded circle before taking the hull, so the outline rounds around nodes. */
export const HULL_SAMPLES = 12;

/**
 * 2D outline of a cluster: the convex hull (Andrew's monotone chain, counter-clockwise) of every
 * extent node's circle of radius `radius + padding`, sampled `HULL_SAMPLES` times. Writes x,y pairs
 * into `out` (capacity: `extent.length * HULL_SAMPLES * 2`) and returns the vertex count.
 */
export function clusterHull2d<N extends ClusterNode>(c: Cluster<N>, padding: number, out: Float32Array): number {
  const pts: Array<[number, number]> = [];
  for (const n of c.extent) {
    if (n.x === undefined) continue;
    const r = n.radius + padding;
    const y = n.y ?? 0;
    for (let s = 0; s < HULL_SAMPLES; s++) {
      const a = (s / HULL_SAMPLES) * Math.PI * 2;
      pts.push([n.x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
  }
  if (pts.length === 0) return 0;
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const hull: Array<[number, number]> = [];
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  const lowerLength = hull.length + 1;
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i];
    while (hull.length >= lowerLength && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  hull.pop();
  for (let i = 0; i < hull.length; i++) {
    out[i * 2] = hull[i][0];
    out[i * 2 + 1] = hull[i][1];
  }
  return hull.length;
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
