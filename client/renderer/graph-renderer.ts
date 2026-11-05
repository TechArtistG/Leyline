import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import type * as Line2Module from "three/addons/lines/Line2.js";
import type * as LineGeometryModule from "three/addons/lines/LineGeometry.js";
import type * as LineMaterialModule from "three/addons/lines/LineMaterial.js";
import type * as LineSegments2Module from "three/addons/lines/LineSegments2.js";
import type * as LineSegmentsGeometryModule from "three/addons/lines/LineSegmentsGeometry.js";
import type { GraphEvent, GraphHandle, GraphMode } from "../../shared/graph";
import type { Connector } from "../../shared/model/connector";
import type { Graph, GraphChange } from "../../shared/model/graph";
import type { GraphNode } from "../../shared/model/node";
import { AgentNode, SubagentNode } from "../../shared/model/nodes";
import { type GraphStyle, type LabelAnchor, StyleResolver } from "../../shared/model/style";
import type {
  AgentRingVisual,
  ColorRef,
  ColorRole,
  ConnectorVisual,
  LabelSettings,
  NodeVisual,
} from "../../shared/model/visual";
import { type AgentState, type ConnectorKind, SUBAGENT_STATES, type SubagentState, TREE_CONNECTOR_KINDS } from "../../shared/model/wire";
import {
  type Cluster,
  type ClusterAxes,
  HULL_SAMPLES,
  ROOT_CLUSTER,
  centerCluster,
  clusterHull2d,
  countClusterOverlaps,
  createCluster,
  forceCluster,
  forceClusterCollide,
  measureCluster,
} from "./clusters";
import { type Label, type LabelLayout, type LabelStyle, createLabel } from "./labels";

// Typechecks without the DOM lib: declare only what this module touches.
declare const window: { devicePixelRatio: number };
declare class ResizeObserver {
  constructor(cb: (entries: ReadonlyArray<{ contentRect: { width: number; height: number } }>) => void);
  observe(el: unknown): void;
  disconnect(): void;
}
export interface HostElement {
  clientWidth: number;
  clientHeight: number;
  appendChild(child: unknown): void;
}
interface PointerEventLike {
  clientX: number;
  clientY: number;
  button: number;
}
type PointerListener = (event: PointerEventLike) => void;
interface CanvasElement {
  style: { display: string; cursor: string };
  addEventListener(type: string, listener: PointerListener): void;
  removeEventListener(type: string, listener: PointerListener): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  remove(): void;
}
interface GlContext {
  VERSION: number;
  getParameter(name: number): unknown;
}

/** Runtime modules, loaded by `client/web.ts` behind the `Platform.OS === "web"` gate. */
export interface RendererLibs {
  THREE: typeof Three;
  OrbitControls: typeof OrbitControlsModule.OrbitControls;
  d3: typeof D3;
  LineSegments2: typeof LineSegments2Module.LineSegments2;
  LineSegmentsGeometry: typeof LineSegmentsGeometryModule.LineSegmentsGeometry;
  LineMaterial: typeof LineMaterialModule.LineMaterial;
  Line2: typeof Line2Module.Line2;
  LineGeometry: typeof LineGeometryModule.LineGeometry;
}

/**
 * Position holder for one node, keyed by id and kept across model updates. Web nodes are d3
 * simulation nodes; spider nodes reuse the shape only for `clusterId`/`lod` (their labels scale
 * with their anchor's cluster) — they are never simulated or positioned, since agentic work is
 * drawn as ring/spoke modifiers on the anchor rather than as nodes.
 */
interface SimNode extends D3.SimulationNode {
  id: string;
  /** Sphere radius in world units (from the resolved visual); drives collision and charge. */
  radius: number;
  /** Repo id this node is contained in (spiders: their anchor's), or `ROOT_CLUSTER` above the repos. */
  clusterId: string;
  /** Label metric/LOD of that cluster; the frame loop reads it per node without a lookup. */
  lod: ClusterLod;
}
interface SimLink extends D3.SimulationLink<SimNode> {
  id: string;
  kind: ConnectorKind;
  /** Preferred resting length from the connector; scaled by `DISTANCE_SCALE`. */
  distance: number;
}
interface NodeEntry {
  node: GraphNode;
  sim: SimNode;
  visual: NodeVisual;
  /** `node.revision` the visual was resolved from; equal → the update was a no-op for us. */
  revision: number;
  /** Spider only: the anchor the ring/spoke placement is based on; differs from `node.anchorId` → re-index. */
  anchorId: string | undefined;
  /** Not `visual.hidden`. Web: has a mesh, is simulated and picked. Spider: eligible for a ring/spoke on its anchor. */
  shown: boolean;
  /** Spider only: currently drawn as a ring or spoke (its anchor chain resolves to a shown web node); the label needs it. */
  placed: boolean;
  /** Web only; null while hidden. Ring and label follow it. */
  mesh: Three.Mesh<Three.BufferGeometry, Three.MeshStandardMaterial> | null;
  ring: Three.Mesh<Three.TorusGeometry, Three.MeshBasicMaterial> | null;
  /** Web: `labelAlways`/LOD or hover/select. Spider: hover/select only, laid out at its ring top or tip. */
  label: Label | null;
}
interface ConnectorEntry {
  connector: Connector;
  link: SimLink;
  /**
   * Both endpoints are shown web nodes: the connector is drawn and is a simulation force. A
   * connector touching a spider is neither — agentic work renders as ring/spoke modifiers.
   */
  active: boolean;
  visual: ConnectorVisual;
  revision: number;
  /** Arrowhead at the target when `visual.directed`, single-lane and active. */
  cone: Three.Mesh<Three.ConeGeometry, Three.MeshBasicMaterial> | null;
}
/**
 * Label metric and zoom LOD of one cluster. Nodes point at their cluster's record, so labels inside
 * one project scale and tier-switch on that project's own screen size. Records are keyed by cluster
 * id and survive cluster rebuilds, which keeps the hysteresis state across model changes.
 */
interface ClusterLod {
  /** Font size for this cluster's labels this frame, CSS px, from px per world unit at the cluster centre (root: at the orbit target). */
  fontPx: number;
  /** True while `all`-tier labels show; flips with hysteresis in the frame loop. */
  lodAll: boolean;
  /** `lodAll` changed this frame: the node loop refreshes label visibility for members. */
  flipped: boolean;
}
/** Hull drawn around one non-root cluster: a flat outline + fill in 2D modes, a translucent sphere in 3D. */
interface ClusterDrawable {
  cluster: Cluster<SimNode>;
  fill: Three.Mesh<Three.BufferGeometry, Three.MeshBasicMaterial>;
  /** 2D only: hull outline sharing the fill's position attribute. */
  outline: Three.LineLoop<Three.BufferGeometry, Three.LineBasicMaterial> | null;
  /** 3D only: faint wireframe over the sphere. */
  wire: Three.Mesh<Three.SphereGeometry, Three.MeshBasicMaterial> | null;
  /** 2D only: hull vertices as x,y pairs, capacity `extent.length × HULL_SAMPLES`. */
  hull: Float32Array;
  positions: Float32Array;
}
/**
 * One fat-line draw: every drawn connector lane sharing a `(width px, dashed, lane, velocity)` key.
 * Width, dash flag and dash offset are material uniforms, hence batch keys; the selected node's
 * connectors (scaled width) land in their own batch. A 2-lane connector contributes one segment to
 * a `lane = +1` batch and one to a `lane = -1` batch, offset to either side of the centre line.
 * Buffers are instanced-interleaved views over the arrays here, updated in place each frame.
 */
interface LineBatch {
  geometry: LineSegmentsGeometryModule.LineSegmentsGeometry;
  material: LineMaterialModule.LineMaterial;
  object: LineSegments2Module.LineSegments2;
  entries: ConnectorEntry[];
  /** `0`: centred single line; `±1`: side of a 2-lane connector, offset `±LANE_GAP` and trimmed to the sphere surfaces. */
  lane: -1 | 0 | 1;
  /** Dash march speed, world units/s along source→target (negative: toward the source); 0 = static. */
  velocity: number;
  positions: Float32Array;
  colors: Float32Array;
  positionBuffer: Three.InterleavedBuffer;
  colorBuffer: Three.InterleavedBuffer;
  /** Dashed only: per-segment `(0, length)` pairs so each connector's dash pattern starts at its source. */
  distances: Float32Array | null;
  distanceBuffer: Three.InterleavedBuffer | null;
}
/** Drawn connectors grouped under one batch key, with the key's components for batch creation. */
interface LineGroup {
  width: number;
  dashed: boolean;
  lane: -1 | 0 | 1;
  velocity: number;
  entries: ConnectorEntry[];
}
/**
 * How a spoke is drawn: a `SubagentNode`'s state as-is, or a child `AgentNode`'s state folded to
 * `running` (executing), `attention`, `failed` (error) or `idle` (idle/thinking, solid ring colour).
 */
type SpokeLook = SubagentState | "attention" | "idle";
/**
 * One radial spoke on an agent ring for one subagent or child agent: two parallel dashed lanes
 * from the ring edge to the tip edge (counter-marching while running), ending in a ring tip
 * (dashed + spinning while running). All live in the ring's group. A running tip owns its dashed
 * `material` so its dash count can follow its on-screen size (`dashes`, see `fitDashes`).
 */
interface Spoke {
  entry: NodeEntry;
  look: SpokeLook;
  tipRadius: number;
  /** Lane `+` (offset along the spoke's left normal) and lane `−`; each owns its geometry. */
  lanes: readonly [Line2Module.Line2, Line2Module.Line2];
  tip: Line2Module.Line2;
  material: LineMaterialModule.LineMaterial | null;
  dashes: number;
}
/**
 * One concentric ring around a worktree for one anchored root agent; dashed + spinning while that
 * agent executes. `group` is the ring plane (billboarded in 3D): the ring line, spokes and tips are
 * its children, so the spin never moves the spokes. `group.scale` is the set's screen-space minimum
 * size clamp (`updateAgentRings`). An executing ring owns its dashed `material` so its dash count
 * can follow its on-screen size (`dashes`, see `fitDashes`); others share a solid material.
 */
interface AgentRing {
  entry: NodeEntry;
  radius: number;
  group: Three.Group;
  line: Line2Module.Line2;
  material: LineMaterialModule.LineMaterial | null;
  dashes: number;
  spokes: Spoke[];
}
/** All agent rings of one web node, in sorted root agent id order (index = ring slot from the inside out). */
interface AgentRingSet {
  entry: NodeEntry;
  /** Reconcile key: spoke length, tip radius, lane gap, then per root agent `(id, executing, ring radius)` and per spoke `(id, look)`. */
  key: string;
  rings: AgentRing[];
  /**
   * Glyph LOD: the inner ring is under `minRadiusPx × SPOKE_SHOW_SCALE` on screen (with
   * `GLYPH_LOD_HYSTERESIS`), so spokes and tips are hidden. Flipped per frame by `updateAgentRings`;
   * visibility changes only on the flip. The rings themselves always draw in their true state.
   */
  spokesHidden: boolean;
}
interface Point {
  x: number;
  y: number;
  z: number;
}

const SEED = 0x1e71;
/** World units per `Connector.distance` unit; spheres are 0.4–1.6 units, so links of 6–20 read as a graph, not a blob. */
const DISTANCE_SCALE = 2;
const CHARGE_STRENGTH = -18;
const CHARGE_DISTANCE_MAX = 60;
const COLLIDE_PADDING = 0.6;
/** Hub modes: `contains` links from the root cluster into a repo are stretched so repo clusters have room to spread. */
const HOST_REPO_DISTANCE_SCALE = 2.5;
/** Pull of each web node toward its cluster centroid (hub modes). */
const CLUSTER_STRENGTH = 0.3;
/** Fraction of a cluster-pair overlap resolved per tick (velocity space; d3 scales velocity by 0.6 before integrating). */
const CLUSTER_COLLIDE_STRENGTH = 0.8;
/** `2d-lr`: x per containment depth; links only pull y, each node is held in its cluster's y band. */
const LR_COLUMN_SPACING = 12;
const LR_ROW_SPACING = 3;
const LR_LINK_DISTANCE = 4;
const LR_LINK_STRENGTH = 0.3;
const LR_CHARGE_STRENGTH = -10;
const LR_BAND_STRENGTH = 0.3;
/** Band height = (tallest column in the cluster + this) × row spacing. */
const LR_BAND_SLACK_ROWS = 1;
/** Within the hull pass (no depth test) the outline/wireframe draws after the fill it borders. */
const HULL_EDGE_RENDER_ORDER = 1;
/** Outline opacity relative to the fill opacity (2D), and wireframe opacity relative to the sphere (3D). */
const HULL_OUTLINE_OPACITY = 2.5;
const HULL_WIRE_OPACITY = 0.35;
const TREE_KINDS: ReadonlySet<ConnectorKind> = new Set(TREE_CONNECTOR_KINDS);
const ALPHA_MIN = 0.001;
/** Ticks until the simulation settles (`alpha < ALPHA_MIN`); one tick per frame → ~3 s at 60 Hz. */
const SETTLE_TICKS = 180;
/** Spread of the initial z offset handed to nodes when entering 3D from a flat layout. */
const Z_SPREAD = 4;
/** Distance from the anchor (group node or connected node) at which a new node starts. */
const SPAWN_RADIUS = 3;
/** World units kept above each node when framing, so a label at fit zoom stays inside the view. */
const LABEL_FIT_HEADROOM = 1.1;
/** LOD threshold hysteresis: labels switch tiers at ±this fraction of `allAbovePxPerUnit`. */
const LABEL_LOD_HYSTERESIS = 0.1;
const FIT_MARGIN = 1.1;
const PULSE_PERIOD_MS = 1600;
const CAMERA_3D_DISTANCE = 60;
const ORTHO_DEPTH = 100;
/** Far clip for both cameras; large so zooming/dollying out never clips the graph. */
const CAMERA_FAR = 100_000;
const CAMERA_NEAR = 0.5;
const ORTHO_INITIAL_ZOOM = 8;
const CLICK_SLOP_PX = 4;
/** Ring radius as a multiple of the node radius; tube is thin so it reads as an outline. */
const RING_SCALE = 1.35;
const RING_TUBE = 0.05;
const CONE_HEIGHT = 0.7;
const CONE_RADIUS = 0.28;
/** Connector dash pattern, world units along the segment (fat-line dash distances are pre-projection). */
const DASH_SIZE = 0.6;
const GAP_SIZE = 0.4;
const DASH_PERIOD = DASH_SIZE + GAP_SIZE;
/** Half-separation of a 2-lane connector's lines from the centre line, world units × max(1, mean endpoint radius). */
const LANE_GAP = 0.12;
/** Cap on the frame delta fed to the dash march, so a throttled/hidden tab resumes without a jump. */
const MARCH_DT_MAX = 0.1;
/**
 * Agent rings: polyline resolution of the shared unit circle, and the adaptive dash count of an
 * executing ring or running tip: one dash+gap per `RING_DASH_PX` of on-screen circumference,
 * clamped to `[RING_DASHES_MIN, RING_DASHES_MAX]` (`fitDashes`).
 */
const AGENT_RING_SEGMENTS = 64;
const RING_DASH_PX = 18;
const RING_DASHES_MIN = 4;
const RING_DASHES_MAX = 12;
/** Spoke lane dash pattern, world units, and the march speed of a running spoke's lanes (units/s, opposite per lane). */
const SPOKE_LANE_DASH = 0.3;
const SPOKE_LANE_GAP = 0.2;
const SPOKE_LANE_PERIOD = SPOKE_LANE_DASH + SPOKE_LANE_GAP;
const SPOKE_LANE_SPEED = 2;
/** Spokes and tips show only while the inner ring is at least `minRadiusPx × SPOKE_SHOW_SCALE` on screen. */
const SPOKE_SHOW_SCALE = 1.5;
/** Spoke LOD band: hide below `threshold × (1 − h)`, show again above `threshold × (1 + h)`. */
const GLYPH_LOD_HYSTERESIS = 0.1;
/** Rings draw after the connector batches (also transparent, order 0) so they are never cut by a line. */
const AGENT_RING_RENDER_ORDER = 1;
/** Subagent spokes spread over at least this many angle slots, so a lone spoke sits at the top and a few stay well apart. */
const SPOKE_MIN_SLOTS = 6;
/** Running tip pulse: scale swings between 1 and 1 + this. */
const TIP_PULSE = 0.25;
/** Extra screen-space hit width when picking fat lines (rings, tips), px either side of the line width. */
const PICK_LINE_THRESHOLD_PX = 6;
/** Every spoke look, for material tables. */
const SPOKE_LOOKS: readonly SpokeLook[] = [...SUBAGENT_STATES, "attention", "idle"];
/** Lane and tip colour per spoke look; `null` = the ring colour (a running tip lightened by `spokeLighten`). */
const SPOKE_LOOK_COLOR: Record<SpokeLook, ColorRef | null> = {
  running: null,
  completed: "muted",
  failed: "danger",
  canceled: "border",
  attention: "warning",
  idle: null,
};
/** Child agent state → spoke look: only `executing` animates; `thinking` reads as idle, as on the main ring. */
const AGENT_SPOKE_LOOK: Record<AgentState, SpokeLook> = {
  idle: "idle",
  thinking: "idle",
  executing: "running",
  attention: "attention",
  error: "failed",
};
const SELECT_EMISSIVE = 0.5;
const HOVER_EMISSIVE = 0.2;

const ROLE_THEME_KEY: Record<ColorRole, "accent" | "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted" | "foreground" | "border"> = {
  accent: "accent",
  success: "statusSuccess",
  warning: "statusWarning",
  danger: "statusDanger",
  muted: "foregroundMuted",
  foreground: "foreground",
  border: "border",
};

/** Tiny seeded LCG (Numerical Recipes constants); returns floats in [0, 1). */
function lcg(seed: number): D3.RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Build a renderer into `host`. All WebGL/DOM work lives here; `client/web.ts` gates it to web. */
export function createGraphRenderer(
  host: HostElement,
  theme: PluginTheme,
  initialMode: GraphMode,
  graph: Graph,
  initialStyle: GraphStyle | undefined,
  libs: RendererLibs,
): GraphHandle {
  const { THREE, OrbitControls, d3, LineSegments2, LineSegmentsGeometry, LineMaterial, Line2, LineGeometry } = libs;

  // ---- style / palette -----------------------------------------------------------------------
  let resolver = new StyleResolver(initialStyle);
  const surface = new THREE.Color(theme.colors.surface0);
  const foreground = new THREE.Color(theme.colors.foreground);
  /** Scratch for `NodeVisual.lighten`: the role colour mixed toward `foreground`. */
  const tintColor = new THREE.Color();
  /** Resolved `ColorRef` → colour; cleared when the style (and thus its palette) changes. */
  let colorCache = new Map<ColorRef, Three.Color>();
  let selectionStyle = resolver.selectionVisual();
  let agentRingStyle: AgentRingVisual = resolver.agentRingVisual();

  /** Role → `style.palette` override, else the theme colour; literal hex as-is (alpha digits dropped). */
  function colorFor(ref: ColorRef): Three.Color {
    let color = colorCache.get(ref);
    if (color) return color;
    const palette = resolver.style.palette;
    const hex = palette?.[ref] ?? (ref.startsWith("#") ? ref.slice(0, 7) : theme.colors[ROLE_THEME_KEY[ref as ColorRole]]);
    color = new THREE.Color(hex);
    colorCache.set(ref, color);
    return color;
  }

  function labelCss(): string {
    return `#${colorFor(resolver.labels().color).getHexString()}`;
  }

  // ---- labels (screen-space) -----------------------------------------------------------------
  let labelSettings: LabelSettings = resolver.labels();
  /** Baked once per label at the largest size it can show; the sprite scales it down per frame. */
  let labelStyle: LabelStyle = { color: labelCss(), bakeFontSizePx: labelSettings.maxFontSizePx };
  /**
   * Cluster id → label metric/LOD record. Rebuilt with the clusters, carrying over each id's
   * record so the hysteresis state (`lodAll`) survives model changes. Ids that only hidden nodes
   * still point at keep a record too, so every `SimNode.lod` stays valid.
   */
  let clusterLodById = new Map<string, ClusterLod>();
  /** `clusterLodById` records aligned with `clusters`, so the frame loop walks both by index. */
  const clusterLods: ClusterLod[] = [];

  function clusterLodFor(id: string): ClusterLod {
    let lod = clusterLodById.get(id);
    if (!lod) clusterLodById.set(id, (lod = { fontPx: labelSettings.fontSizePx, lodAll: true, flipped: false }));
    return lod;
  }
  /** Reused per frame; `fontPx` is per cluster, `anchor` and `clearancePx` per node, `scalePerPx` per frame. */
  const labelLayout: LabelLayout = { fontPx: labelSettings.fontSizePx, scalePerPx: 1, anchor: "above", clearancePx: 0 };
  const labelTmp = new THREE.Vector3();

  // ---- renderer / scene ----------------------------------------------------------------------
  let width = Math.max(1, host.clientWidth);
  let height = Math.max(1, host.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const canvas = renderer.domElement as unknown as CanvasElement;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  // Two passes per frame (hulls, then the graph): cleared once by hand in the frame loop.
  renderer.autoClear = false;
  canvas.style.display = "block";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 7);
  scene.add(key);
  /**
   * Cluster hulls live in their own scene, rendered before `scene` without depth: they are a
   * backdrop and never occlude a node, connector or label, whatever the depths involved.
   */
  const hullScene = new THREE.Scene();

  const sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
  const dodecahedronGeometry = new THREE.DodecahedronGeometry(1, 0);
  const dodecahedronClusterGeometry = buildDodecahedronCluster();
  const geometryFor = (shape: NodeVisual["shape"]): Three.BufferGeometry =>
    shape === "dodecahedron" ? dodecahedronGeometry : shape === "dodecahedron-cluster" ? dodecahedronClusterGeometry : sphereGeometry;

  /**
   * A central dodecahedron with one mated on each of its 12 faces. Faces come in parallel pairs, so
   * an untransformed copy translated by twice the inradius along a face normal sits flush. Scaled so
   * the whole cluster fits a unit radius (slightly over, so it reads bulkier than a unit sphere).
   */
  function buildDodecahedronCluster(): Three.BufferGeometry {
    const unit = dodecahedronGeometry.getAttribute("position").array as Float32Array;
    const normals = dodecahedronGeometry.getAttribute("normal").array as Float32Array;
    // Face normals and inradius straight from the mesh: three's DodecahedronGeometry is non-indexed with
    // flat per-triangle normals, so the 12 distinct normals are the pentagon faces and the inradius is
    // the distance from the centre to any face plane (vertex · normal).
    const dirs: number[][] = [];
    let inradius = 0;
    for (let i = 0; i < normals.length; i += 3) {
      const n = [normals[i], normals[i + 1], normals[i + 2]];
      if (dirs.some((d) => d[0] * n[0] + d[1] * n[1] + d[2] * n[2] > 0.999)) continue;
      dirs.push(n);
      inradius = unit[i] * n[0] + unit[i + 1] * n[1] + unit[i + 2] * n[2];
    }
    // Opposite faces are parallel but their pentagons differ by a 36° twist, so each neighbour is
    // rotated π/5 about its face normal before being pushed out by twice the inradius; its facing
    // pentagon then lands edge-for-edge on the central one.
    const extent = 1 + inradius * 2 + 1;
    const scale = 1.2 / extent;
    const count = dirs.length + 1;
    const positions = new Float32Array(unit.length * count);
    const outNormals = new Float32Array(normals.length * count);
    positions.set(unit.map((v) => v * scale), 0);
    outNormals.set(normals, 0);
    const rotation = new THREE.Matrix4();
    const axis = new THREE.Vector3();
    const p = new THREE.Vector3();
    dirs.forEach((d, c) => {
      const base = (c + 1) * unit.length;
      axis.set(d[0], d[1], d[2]);
      rotation.makeRotationAxis(axis, Math.PI / 5);
      for (let i = 0; i < unit.length; i += 3) {
        p.set(unit[i], unit[i + 1], unit[i + 2]).applyMatrix4(rotation).addScaledVector(axis, inradius * 2).multiplyScalar(scale);
        positions[base + i] = p.x;
        positions[base + i + 1] = p.y;
        positions[base + i + 2] = p.z;
        p.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix4(rotation);
        outNormals[base + i] = p.x;
        outNormals[base + i + 1] = p.y;
        outNormals[base + i + 2] = p.z;
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(outNormals, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
  /** Stable hue per label (FNV-1a), tuned for a dark surface. */
  const labelHashColor = (label: string, out: Three.Color): Three.Color => {
    let h = 0x811c9dc5;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    return out.setHSL(((h >>> 0) % 360) / 360, 0.55, 0.55);
  };
  const ringGeometry = new THREE.TorusGeometry(1, RING_TUBE, 8, 48);
  const coneGeometry = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 12);

  /**
   * Fat-line helper: dash distances are a per-instance `(start, end)` pair that three's
   * `computeLineDistances` reallocates on every call; attach a buffer we own instead so the
   * frame loop can refresh it in place.
   */
  function attachLineDistances(
    geometry: LineSegmentsGeometryModule.LineSegmentsGeometry,
    distances: Float32Array,
    usage: Three.Usage,
  ): Three.InterleavedBuffer {
    const buffer = new THREE.InstancedInterleavedBuffer(distances, 2, 1).setUsage(usage);
    geometry.setAttribute("instanceDistanceStart", new THREE.InterleavedBufferAttribute(buffer, 1, 0));
    geometry.setAttribute("instanceDistanceEnd", new THREE.InterleavedBufferAttribute(buffer, 1, 1));
    return buffer;
  }

  // Opacity per connector is pre-mixed into the vertex colours against the surface colour, so one
  // draw call per batch carries every opacity. Width, dash flag and dash offset (march) are material
  // uniforms of the fat-line shader, so connectors are batched by `(width, dashed, lane, velocity)`;
  // the few distinct style widths/speeds keep this small.
  const lineBatches = new Map<string, LineBatch>();
  /** `lineBatches` values as an array for the frame loop. */
  let lineBatchList: LineBatch[] = [];

  function createLineMaterial(linewidth: number, dashed: boolean): LineMaterialModule.LineMaterial {
    const material = new LineMaterial({
      linewidth,
      worldUnits: false,
      vertexColors: true,
      dashed,
      dashSize: DASH_SIZE,
      gapSize: GAP_SIZE,
      transparent: true,
      alphaToCoverage: true,
      toneMapped: false,
    });
    material.resolution.set(width, height);
    return material;
  }

  type LineBuffers = Pick<LineBatch, "positions" | "colors" | "positionBuffer" | "colorBuffer" | "distances" | "distanceBuffer">;

  /** Attach `count` zeroed segments to a fresh geometry; the returned arrays are what the frame loop writes. */
  function fillLineGeometry(geometry: LineSegmentsGeometryModule.LineSegmentsGeometry, dashed: boolean, count: number): LineBuffers {
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    // `setPositions`/`setColors` wrap a Float32Array without copying; keep the interleaved buffers to flag updates.
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const positionBuffer = (geometry.getAttribute("instanceStart") as Three.InterleavedBufferAttribute).data;
    positionBuffer.setUsage(THREE.DynamicDrawUsage);
    const colorBuffer = (geometry.getAttribute("instanceColorStart") as Three.InterleavedBufferAttribute).data;
    const distances = dashed ? new Float32Array(count * 2) : null;
    const distanceBuffer = distances ? attachLineDistances(geometry, distances, THREE.DynamicDrawUsage) : null;
    return { positions, colors, positionBuffer, colorBuffer, distances, distanceBuffer };
  }

  function createLineBatch(group: LineGroup): LineBatch {
    const geometry = new LineSegmentsGeometry();
    const material = createLineMaterial(group.width, group.dashed);
    const object = new LineSegments2(geometry, material);
    object.frustumCulled = false;
    scene.add(object);
    return {
      geometry,
      material,
      object,
      entries: group.entries,
      lane: group.lane,
      velocity: group.velocity,
      ...fillLineGeometry(geometry, group.dashed, group.entries.length),
    };
  }

  /** Resize a batch to `count` segments: a fresh geometry releases the old GPU buffers with it. */
  function resizeLineBatch(batch: LineBatch, count: number): void {
    batch.geometry.dispose();
    batch.geometry = new LineSegmentsGeometry();
    batch.object.geometry = batch.geometry;
    Object.assign(batch, fillLineGeometry(batch.geometry, batch.material.dashed, count));
  }

  function disposeLineBatch(batch: LineBatch): void {
    scene.remove(batch.object);
    batch.geometry.dispose();
    batch.material.dispose();
  }

  // Agent glyphs (rings, tips): a unit circle polyline shared by every ring and tip (scaled per
  // object; screen-space width is scale-independent). Dash distances are static in the geometry's
  // unit space, so a material's dash/gap size tiles the circle with a fixed dash count regardless
  // of radius; executing rings and running tips own their material and retile it to their on-screen
  // size (`fitDashes`). Spoke lanes are per-spoke segments in world units (`createLane`) with their
  // own dash pattern.
  const agentRingGeometry = new LineGeometry();
  const agentRingChord = 2 * Math.sin(Math.PI / AGENT_RING_SEGMENTS);
  /** Length of the unit circle polyline in its dash-distance space (the polygon perimeter). */
  const agentRingPerimeter = AGENT_RING_SEGMENTS * agentRingChord;
  /** Dash length of a freshly created ring/tip material: `RING_DASHES_MAX` dashes, retiled on first frame. */
  const agentRingDash = agentRingPerimeter / (RING_DASHES_MAX * 2);
  {
    const points = new Float32Array((AGENT_RING_SEGMENTS + 1) * 3);
    for (let i = 0; i <= AGENT_RING_SEGMENTS; i++) {
      const angle = (i / AGENT_RING_SEGMENTS) * Math.PI * 2;
      points[i * 3] = Math.cos(angle);
      points[i * 3 + 1] = Math.sin(angle);
    }
    agentRingGeometry.setPositions(points);
    const distances = new Float32Array(AGENT_RING_SEGMENTS * 2);
    for (let i = 0; i < AGENT_RING_SEGMENTS; i++) {
      distances[i * 2] = i * agentRingChord;
      distances[i * 2 + 1] = (i + 1) * agentRingChord;
    }
    attachLineDistances(agentRingGeometry, distances, THREE.StaticDrawUsage);
  }
  /** Every glyph material, for the resize/restyle/dispose sweeps that must treat them all alike. */
  const glyphMaterials = new Set<LineMaterialModule.LineMaterial>();
  /**
   * All glyph materials come from here so that solid and dashed variants differ in nothing but
   * `dashed`/`dashSize`/`gapSize`: same `linewidth` (restyled together), `resolution` (resized
   * together), opacity, `alphaToCoverage`, `dashScale` and depth write. Ring materials skip the
   * depth test so a ring enlarged to `minRadiusPx` always draws over its node. The only remaining
   * difference is in the shader itself, which discards the round endcaps of dashed segments.
   */
  function createGlyphMaterial(dashed: boolean, dash: number, gap = dash, depthTest = true): LineMaterialModule.LineMaterial {
    const material = new LineMaterial({
      linewidth: agentRingStyle.width,
      worldUnits: false,
      dashed,
      dashScale: 1,
      dashSize: dash,
      gapSize: gap,
      opacity: 1,
      transparent: true,
      alphaToCoverage: true,
      depthTest,
      depthWrite: false,
      toneMapped: false,
    });
    material.resolution.set(width, height);
    glyphMaterials.add(material);
    return material;
  }
  /** Solid (non-executing) ring materials indexed `[selected ? 1 : 0]`; the selected one is `selection.widthScale` wider. */
  const solidRingMaterials = [
    createGlyphMaterial(false, agentRingDash, agentRingDash, false),
    createGlyphMaterial(false, agentRingDash, agentRingDash, false),
  ];
  /** Dashed ring material for one executing agent: ring colour, `selection.widthScale` wider while selected. */
  function createRingMaterial(selected: boolean): LineMaterialModule.LineMaterial {
    const material = createGlyphMaterial(true, agentRingDash, agentRingDash, false);
    material.color.copy(solidRingMaterials[0].color);
    material.linewidth = agentRingStyle.width * (selected ? selectionStyle.widthScale : 1);
    return material;
  }
  /** Dashed tip material for one running subagent: colour from the `running` tip template. */
  function createTipMaterial(): LineMaterialModule.LineMaterial {
    const material = createGlyphMaterial(true, agentRingDash);
    material.color.copy(tipMaterials.running.color);
    return material;
  }
  /**
   * Spoke lane materials per look, `[+, −]`: both dashed in world units (lane geometry is in the
   * ring plane at scale 1); the `running` pair is marched in opposite directions each frame.
   */
  const laneMaterials = {} as Record<SpokeLook, readonly [LineMaterialModule.LineMaterial, LineMaterialModule.LineMaterial]>;
  /**
   * Tip ring per look: solid, shared by every tip of that look. The `running` entry is dashed but
   * only a template: each running tip owns a copy (`createTipMaterial`) that holds the lightened
   * ring colour and is retiled to the tip's on-screen size.
   */
  const tipMaterials = {} as Record<SpokeLook, LineMaterialModule.LineMaterial>;
  for (const look of SPOKE_LOOKS) {
    laneMaterials[look] = [
      createGlyphMaterial(true, SPOKE_LANE_DASH, SPOKE_LANE_GAP),
      createGlyphMaterial(true, SPOKE_LANE_DASH, SPOKE_LANE_GAP),
    ];
    tipMaterials[look] = createGlyphMaterial(look === "running", agentRingDash);
  }

  /**
   * Apply the agent-ring style (width, colours) to every glyph material. Per-object materials
   * (executing rings, running tips) are swept too, then `refreshRingMaterials` restores their
   * selection width and tip colour.
   */
  function restyleGlyphMaterials(): void {
    const ringColor = colorFor(agentRingStyle.color);
    for (const material of glyphMaterials) {
      material.linewidth = agentRingStyle.width;
      material.color.copy(ringColor);
    }
    solidRingMaterials[1].linewidth = agentRingStyle.width * selectionStyle.widthScale;
    for (const look of SPOKE_LOOKS) {
      const ref = SPOKE_LOOK_COLOR[look];
      if (ref === null) continue;
      const color = colorFor(ref);
      laneMaterials[look][0].color.copy(color);
      laneMaterials[look][1].color.copy(color);
      tipMaterials[look].color.copy(color);
    }
    tipMaterials.running.color.copy(ringColor).lerp(foreground, agentRingStyle.spokeLighten);
  }
  restyleGlyphMaterials();
  /** Web node id → its agent rings. */
  const agentRingSets = new Map<string, AgentRingSet>();
  /** Set by node restyles (agent state, anchor radius); cleared by `rebuildAgentRings`. */
  let agentRingsDirty = false;
  const agentRingAxis = new THREE.Vector3(0, 0, 1);
  /** Scratch: world position of a ring top / spoke tip for its label. */
  const glyphTmp = new THREE.Vector3();
  /** Everything the pointer can hit: web node meshes, agent ring lines and spoke tip rings, each carrying `userData.id`. */
  const pickables: Three.Object3D[] = [];

  // ---- camera / controls ---------------------------------------------------------------------
  let mode: GraphMode = initialMode;
  let camera: Three.Camera = createCamera(mode);
  let controls: OrbitControlsModule.OrbitControls = createControls(camera, mode);

  function createCamera(target: GraphMode): Three.Camera {
    if (target === "3d-hub") {
      const cam = new THREE.PerspectiveCamera(50, width / height, CAMERA_NEAR, CAMERA_FAR);
      cam.position.set(0, CAMERA_3D_DISTANCE * 0.2, CAMERA_3D_DISTANCE);
      cam.lookAt(0, 0, 0);
      return cam;
    }
    const cam = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, -CAMERA_FAR, CAMERA_FAR);
    cam.zoom = ORTHO_INITIAL_ZOOM;
    cam.position.set(0, 0, ORTHO_DEPTH);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    return cam;
  }

  function createControls(cam: Three.Camera, target: GraphMode): OrbitControlsModule.OrbitControls {
    const c = new OrbitControls(cam, renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.1;
    if (target === "3d-hub") {
      c.minDistance = 2;
      c.maxDistance = CAMERA_FAR / 2;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    } else {
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      c.minZoom = 0.05;
      c.maxZoom = 200;
    }
    return c;
  }

  function resize(w: number, h: number): void {
    width = w;
    height = h;
    renderer.setSize(w, h);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      camera.left = -w / 2;
      camera.right = w / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
    }
    // Screen-space line widths are computed against the viewport; `LineSegments2.onBeforeRender`
    // refreshes this too, but only for objects that render, so keep every material current
    // (picking reads it too, and solid/dashed glyphs must agree).
    for (const batch of lineBatchList) batch.material.resolution.set(w, h);
    for (const material of glyphMaterials) material.resolution.set(w, h);
  }
  const resizeObserver = new ResizeObserver(([entry]) => {
    resize(Math.max(1, entry.contentRect.width), Math.max(1, entry.contentRect.height));
  });
  resizeObserver.observe(host);

  // ---- simulation ----------------------------------------------------------------------------
  const entries = new Map<string, NodeEntry>();
  const connectorEntries = new Map<string, ConnectorEntry>();
  let nodeList: SimNode[] = [];
  let linkList: SimLink[] = [];
  /** Jitter source for spawn offsets and 3D inflation; reseeded by `relayout()`. */
  let rng = lcg(SEED);

  const linkForce = d3.forceLink<SimNode, SimLink>([]).id((n) => n.id);
  /** d3's default: 1 / min(degree) per link; restored when leaving `2d-lr`. */
  const defaultLinkStrength = linkForce.strength();
  const chargeForce = d3.forceManyBody<SimNode>().distanceMax(CHARGE_DISTANCE_MAX);
  const centerForce = d3.forceCenter<SimNode>(0, 0, 0);
  /** `2d-lr`: each node is held in its cluster's y band (bands are assigned by `prepareLayout`). */
  const bandForce = d3.forceY<SimNode>((n) => clusterById.get(n.clusterId)?.bandY ?? 0).strength(LR_BAND_STRENGTH);
  const simulation = d3
    .forceSimulation<SimNode>([], mode === "3d-hub" ? 3 : 2)
    .randomSource(lcg(SEED))
    .alphaMin(ALPHA_MIN)
    .alphaDecay(1 - Math.pow(ALPHA_MIN, 1 / SETTLE_TICKS))
    .force("link", linkForce)
    .force("charge", chargeForce)
    .force("collide", d3.forceCollide<SimNode>((n) => n.radius + COLLIDE_PADDING))
    // d3 starts its own rAF timer on construction; ticks are driven from the render loop instead
    // so that the number of ticks (and therefore the final layout) does not depend on frame timing.
    .stop();
  let fitPending = false;

  // ---- clusters ------------------------------------------------------------------------------
  /** Every cluster with a shown member, sorted by id (the forces iterate in this order); root included. */
  let clusters: Cluster<SimNode>[] = [];
  const clusterById = new Map<string, Cluster<SimNode>>();
  let clusterStyle = resolver.clusterVisual();

  function clusterAxes(): ClusterAxes {
    return mode === "2d-lr" ? "y" : mode === "3d-hub" ? "xyz" : "xy";
  }

  /**
   * Nearest `repo` reached by walking incoming tree connectors (except `merges-into`, which flows
   * sideways into integration targets and PRs). A node with no tree parent (a PR hangs only off
   * `merges-into`) continues through its `group`; `ROOT_CLUSTER` when the walk ends above the repos.
   */
  function repoAncestor(id: string, memo: Map<string, string>, trail: Set<string>): string {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = graph.nodes.get(id);
    let result = ROOT_CLUSTER;
    if (node?.kind === "repo") {
      result = id;
    } else if (node && !trail.has(id)) {
      trail.add(id);
      let parentId: string | undefined;
      for (const c of graph.connectorsOf(id)) {
        if (c.target !== id || c.kind === "merges-into" || !TREE_KINDS.has(c.kind)) continue;
        if (parentId === undefined || c.source < parentId) parentId = c.source;
      }
      if (parentId === undefined && node.group !== undefined && node.group !== id) parentId = node.group;
      if (parentId !== undefined) result = repoAncestor(parentId, memo, trail);
    }
    memo.set(id, result);
    return result;
  }

  /** Reassign every node's cluster and rebuild the cluster list (members and extent: shown web nodes; spiders only take a cluster for their label LOD). */
  function rebuildClusters(): void {
    const memo = new Map<string, string>();
    clusterById.clear();
    const clusterFor = (id: string): Cluster<SimNode> => {
      let c = clusterById.get(id);
      if (!c) clusterById.set(id, (c = createCluster<SimNode>(id)));
      return c;
    };
    const previousLods = clusterLodById;
    clusterLodById = new Map();
    const lodFor = (id: string): ClusterLod => {
      const kept = previousLods.get(id);
      if (kept && !clusterLodById.has(id)) clusterLodById.set(id, kept);
      return clusterLodFor(id);
    };
    for (const e of entries.values()) {
      if (e.node.layer !== "web") continue;
      e.sim.clusterId = repoAncestor(e.node.id, memo, new Set());
      e.sim.lod = lodFor(e.sim.clusterId);
      if (!e.mesh) continue;
      const c = clusterFor(e.sim.clusterId);
      c.members.push(e.sim);
      c.extent.push(e.sim);
    }
    for (const e of entries.values()) {
      if (e.node.layer !== "spider") continue;
      // Follow the anchor chain to a shown web node, so the spider's label scales with that cluster.
      let anchor: NodeEntry | undefined = e;
      let hops = 0;
      while (anchor && anchor.node.layer === "spider" && anchor.shown && hops++ <= entries.size) {
        anchor = anchor.anchorId !== undefined ? entries.get(anchor.anchorId) : undefined;
      }
      e.sim.clusterId = anchor?.mesh ? anchor.sim.clusterId : ROOT_CLUSTER;
      e.sim.lod = lodFor(e.sim.clusterId);
    }
    clusters = [...clusterById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    clusterLods.length = 0;
    for (const c of clusters) clusterLods.push(lodFor(c.id));
    rebuildClusterDrawables();
  }

  /** Overlapping cluster pairs under the current mode's measure; debug hook for the orchestrator. */
  function clusterOverlaps(): number {
    return countClusterOverlaps(clusters, clusterStyle.padding, clusterAxes());
  }

  function configureForces(): void {
    const axes = clusterAxes();
    const clusterCollide = forceClusterCollide(() => clusters, () => clusterStyle.padding, CLUSTER_COLLIDE_STRENGTH, axes);
    if (mode === "2d-lr") {
      linkForce.distance(LR_LINK_DISTANCE).strength(LR_LINK_STRENGTH);
      chargeForce.strength(LR_CHARGE_STRENGTH);
      simulation.force("center", null).force("y", bandForce).force("cluster", null).force("clusterCollide", clusterCollide);
    } else {
      linkForce
        .distance((l) => {
          // A repo is the root of its own cluster; its `contains` link from host/universe gets the extra room.
          const intoRepo = l.kind === "contains" && l.target.clusterId !== ROOT_CLUSTER && l.target.clusterId === l.target.id;
          return l.distance * DISTANCE_SCALE * (intoRepo ? HOST_REPO_DISTANCE_SCALE : 1);
        })
        .strength(defaultLinkStrength);
      chargeForce.strength(CHARGE_STRENGTH);
      simulation
        .force("center", centerForce)
        .force("y", null)
        .force("cluster", forceCluster(() => clusters, CLUSTER_STRENGTH, axes))
        .force("clusterCollide", clusterCollide);
    }
  }
  configureForces();

  /** BFS depth over tree connectors from roots (no incoming tree connector); unreachable nodes go one past the deepest column. */
  function treeDepths(): Map<SimNode, number> {
    const children = new Map<SimNode, SimNode[]>();
    const hasParent = new Set<SimNode>();
    for (const l of linkList) {
      if (!TREE_KINDS.has(l.kind)) continue;
      let list = children.get(l.source);
      if (!list) children.set(l.source, (list = []));
      list.push(l.target);
      hasParent.add(l.target);
    }
    const depth = new Map<SimNode, number>();
    const queue: SimNode[] = [];
    for (const n of nodeList) {
      if (hasParent.has(n)) continue;
      depth.set(n, 0);
      queue.push(n);
    }
    let deepest = 0;
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i];
      const d = depth.get(n) ?? 0;
      for (const child of children.get(n) ?? []) {
        if (depth.has(child)) continue;
        depth.set(child, d + 1);
        if (d + 1 > deepest) deepest = d + 1;
        queue.push(child);
      }
    }
    for (const n of nodeList) if (!depth.has(n)) depth.set(n, deepest + 1);
    return depth;
  }

  /**
   * Mode-specific constraints that must be in place before d3 (re)initialises node positions:
   * `2d-lr` pins x per column, gives each cluster a contiguous y band (root in the middle) and
   * seeds y by index within the cluster's column; hub modes release x.
   */
  function prepareLayout(): void {
    if (mode !== "2d-lr") {
      for (const n of nodeList) n.fx = null;
      return;
    }
    const depth = treeDepths();
    let columns = 0;
    for (const d of depth.values()) if (d + 1 > columns) columns = d + 1;
    const ordered = clusters.filter((c) => c.id !== ROOT_CLUSTER);
    const root = clusterById.get(ROOT_CLUSTER);
    if (root) ordered.splice(ordered.length >> 1, 0, root);
    // Band height follows the cluster's tallest column; bands stack with the hull padding between.
    const rows = new Map<Cluster<SimNode>, number[]>();
    const heights: number[] = [];
    let total = Math.max(0, ordered.length - 1) * clusterStyle.padding;
    for (const c of ordered) {
      const counts: number[] = new Array<number>(columns).fill(0);
      let tallest = 0;
      for (const n of c.members) {
        const count = ++counts[depth.get(n) ?? 0];
        if (count > tallest) tallest = count;
      }
      rows.set(c, counts);
      const h = (tallest + LR_BAND_SLACK_ROWS) * LR_ROW_SPACING;
      heights.push(h);
      total += h;
    }
    const placed = new Map<Cluster<SimNode>, number[]>();
    let edge = -total / 2;
    ordered.forEach((c, i) => {
      c.bandY = edge + heights[i] / 2;
      edge += heights[i] + clusterStyle.padding;
      placed.set(c, new Array<number>(columns).fill(0));
    });
    for (const n of nodeList) {
      const column = depth.get(n) ?? 0;
      n.fx = (column - (columns - 1) / 2) * LR_COLUMN_SPACING;
      const c = clusterById.get(n.clusterId);
      const counts = c ? rows.get(c) : undefined;
      const slots = c ? placed.get(c) : undefined;
      if (!c || !counts || !slots) continue;
      if (n.y === undefined || Number.isNaN(n.y)) {
        n.y = c.bandY + (slots[column] - (counts[column] - 1) / 2) * LR_ROW_SPACING;
        n.vy = 0;
      }
      slots[column]++;
    }
  }

  /** Pin z in 2D modes (forces never touch it); in 3D unpin and give flat layouts a deterministic depth. */
  function enforceDimensions(): void {
    if (mode !== "3d-hub") {
      for (const n of nodeList) {
        n.z = 0;
        n.vz = 0;
        n.fz = 0;
      }
      return;
    }
    let flat = true;
    for (const n of nodeList) {
      n.fz = null;
      if (n.z === undefined || Number.isNaN(n.z)) n.z = 0;
      if (n.vz === undefined || Number.isNaN(n.vz)) n.vz = 0;
      if (n.z !== 0) flat = false;
    }
    if (flat) for (const n of nodeList) n.z = (rng() - 0.5) * 2 * Z_SPREAD;
  }

  /** Push the current web node/link lists into the simulation and rebuild dependent buffers. */
  function syncSimulation(): void {
    nodeList = [];
    for (const e of entries.values()) if (e.mesh) nodeList.push(e.sim);
    linkList = [];
    for (const e of connectorEntries.values()) {
      classifyConnector(e);
      if (e.active) linkList.push(e.link);
    }
    rebuildAnchorIndex();
    rebuildClusters();
    prepareLayout();
    simulation.nodes(nodeList);
    enforceDimensions();
    linkForce.links(linkList);
    configureForces();
    rebuildLineBuffers();
  }

  // ---- spiders -------------------------------------------------------------------------------
  /** Anchor id → ids of the shown spiders riding on it, in stable (sorted) order; drives ring and spoke slots. */
  const anchoredBy = new Map<string, string[]>();
  /** Timestamp of the last animation frame, for the dash march delta. */
  let lastFrameTime = 0;

  function rebuildAnchorIndex(): void {
    anchoredBy.clear();
    for (const e of entries.values()) {
      if (e.anchorId === undefined || !e.shown) continue;
      let list = anchoredBy.get(e.anchorId);
      if (!list) anchoredBy.set(e.anchorId, (list = []));
      list.push(e.node.id);
    }
    for (const list of anchoredBy.values()) list.sort();
    rebuildAgentRings();
  }

  /** Spider anchor moved in the model: re-index so its ring/spoke lands on the new anchor. */
  function retargetSpider(entry: NodeEntry): void {
    entry.anchorId = entry.node.anchorId;
    rebuildAnchorIndex();
    rebuildClusters();
  }

  // ---- node visuals --------------------------------------------------------------------------
  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  /**
   * Hover/select always show; otherwise `labelAlways`, gated by the node's cluster zoom LOD for
   * `all`-tier labels. Spiders are ring/spoke modifiers: their label is a hover/select affordance only.
   */
  function labelVisible(entry: NodeEntry): boolean {
    const id = entry.node.id;
    if (id === selectedId || id === hoveredId) return true;
    if (entry.node.layer === "spider") return false;
    return entry.visual.labelAlways && (entry.sim.lod.lodAll || entry.visual.labelTier === "project");
  }

  function refreshLabel(entry: NodeEntry): void {
    const drawn = entry.node.layer === "web" ? entry.mesh !== null : entry.placed;
    if (!drawn || !labelVisible(entry)) {
      if (entry.label) entry.label.sprite.visible = false;
      return;
    }
    if (!entry.label) {
      entry.label = createLabel(THREE, entry.node.label, labelStyle);
      scene.add(entry.label.sprite);
    } else {
      // Both compare before touching the texture: no re-bake unless text, colour or font changed.
      entry.label.setText(entry.node.label);
      entry.label.setStyle(labelStyle);
    }
    entry.label.sprite.visible = true;
  }

  function refreshMaterial(entry: NodeEntry): void {
    const { node, mesh, visual } = entry;
    if (!mesh) return;
    // `lighten` tints the role colour toward the foreground; base and emissive share the tint.
    if (visual.colorByLabel) labelHashColor(node.label, tintColor);
    else tintColor.copy(colorFor(visual.color));
    tintColor.lerp(foreground, visual.lighten);
    mesh.material.color.copy(tintColor);
    mesh.material.emissive.copy(tintColor);
    let intensity = visual.emissive;
    if (node.id === selectedId) intensity += SELECT_EMISSIVE;
    if (node.id === hoveredId) intensity += HOVER_EMISSIVE;
    mesh.material.emissiveIntensity = intensity;
    const geometry = geometryFor(visual.shape);
    if (mesh.geometry !== geometry) {
      mesh.geometry = geometry;
      mesh.material.flatShading = visual.shape !== "sphere";
      mesh.material.needsUpdate = true;
    }
  }

  function refreshRing(entry: NodeEntry): void {
    const ref = entry.visual.ring;
    if (ref === undefined || !entry.mesh) {
      if (entry.ring) {
        scene.remove(entry.ring);
        entry.ring.material.dispose();
        entry.ring = null;
      }
      return;
    }
    if (!entry.ring) {
      entry.ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ toneMapped: false }));
      scene.add(entry.ring);
    }
    entry.ring.material.color.copy(colorFor(ref));
    entry.ring.scale.setScalar(entry.visual.radius * RING_SCALE);
  }

  /** Give a shown web node its sphere; nodes without a position start near an anchor so they do not fly in from the origin. */
  function mountNode(entry: NodeEntry): void {
    const { node, sim, visual } = entry;
    // Without an anchor, leave the position undefined and let d3's deterministic phyllotaxis placement handle it.
    const anchor = sim.x === undefined ? anchorFor(node) : null;
    if (anchor) {
      const angle = rng() * Math.PI * 2;
      const r = SPAWN_RADIUS * (0.5 + rng() * 0.5);
      sim.x = anchor.x + Math.cos(angle) * r;
      sim.y = anchor.y + Math.sin(angle) * r;
      sim.z = mode === "3d-hub" ? anchor.z + (rng() - 0.5) * r : 0;
    }
    const mesh = new THREE.Mesh(
      geometryFor(visual.shape),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, flatShading: visual.shape !== "sphere" }),
    );
    mesh.scale.setScalar(visual.radius);
    mesh.userData.id = node.id;
    scene.add(mesh);
    entry.mesh = mesh;
  }

  function unmountNode(entry: NodeEntry): void {
    if (entry.mesh) {
      scene.remove(entry.mesh);
      entry.mesh.material.dispose();
      entry.mesh = null;
    }
    if (entry.ring) {
      scene.remove(entry.ring);
      entry.ring.material.dispose();
      entry.ring = null;
    }
    entry.label?.dispose();
    entry.label = null;
  }

  /**
   * Re-resolve a node's visual and apply every dependent piece (scale, material, ring, label).
   * Returns true when `hidden` flipped: the node entered or left the shown set (web: drawn and
   * simulated; spider: eligible for a ring/spoke).
   */
  function restyleNode(entry: NodeEntry): boolean {
    entry.visual = resolver.nodeVisual(entry.node);
    entry.revision = entry.node.revision;
    entry.sim.radius = entry.visual.radius;
    const flipped = entry.visual.hidden === entry.shown;
    if (flipped) {
      entry.shown = !entry.visual.hidden;
      if (entry.node.layer === "web") {
        if (entry.shown) mountNode(entry);
        else unmountNode(entry);
      }
    }
    if (entry.mesh) entry.mesh.scale.setScalar(entry.visual.radius);
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    if (entry.anchorId !== entry.node.anchorId) retargetSpider(entry);
    // Agent state (dashed/spinning ring) and anchor radius (ring radii) both feed the agent rings.
    agentRingsDirty = true;
    return flipped;
  }

  /** Where a new node should start: its group node, the centroid of its group, or a connected node. */
  function anchorFor(node: GraphNode): Point | null {
    if (node.group) {
      const groupSim = entries.get(node.group)?.sim;
      if (groupSim && groupSim.x !== undefined) return { x: groupSim.x, y: groupSim.y ?? 0, z: groupSim.z ?? 0 };
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (const e of entries.values()) {
        if (e.node.group !== node.group || e.sim.x === undefined) continue;
        sx += e.sim.x;
        sy += e.sim.y ?? 0;
        sz += e.sim.z ?? 0;
        count++;
      }
      if (count > 0) return { x: sx / count, y: sy / count, z: sz / count };
    }
    for (const otherId of graph.neighbors(node.id)) {
      const other = entries.get(otherId)?.sim;
      if (other && other.x !== undefined) return { x: other.x, y: other.y ?? 0, z: other.z ?? 0 };
    }
    return null;
  }

  function createEntry(node: GraphNode): NodeEntry {
    const visual = resolver.nodeVisual(node);
    const entry: NodeEntry = {
      node,
      sim: { id: node.id, radius: visual.radius, clusterId: ROOT_CLUSTER, lod: clusterLodFor(ROOT_CLUSTER) },
      visual,
      revision: node.revision,
      anchorId: node.anchorId,
      shown: !visual.hidden,
      placed: false,
      mesh: null,
      ring: null,
      label: null,
    };
    if (entry.shown && node.layer === "web") mountNode(entry);
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    return entry;
  }

  // ---- connectors ----------------------------------------------------------------------------
  const tmpColor = new THREE.Color();
  const tmpMix = new THREE.Color();
  const tmpDir = new THREE.Vector3();
  /** Scratch: camera view direction, refreshed once per `updateLinePositions`. */
  const cameraForward = new THREE.Vector3();
  const coneUp = new THREE.Vector3(0, 1, 0);

  function refreshCone(entry: ConnectorEntry): void {
    // Two-lane connectors are undirected by construction: a cone would sit between the lanes.
    if (!entry.visual.directed || entry.visual.lanes === 2 || !entry.active) {
      if (entry.cone) {
        scene.remove(entry.cone);
        entry.cone.material.dispose();
        entry.cone = null;
      }
      return;
    }
    if (!entry.cone) {
      entry.cone = new THREE.Mesh(coneGeometry, new THREE.MeshBasicMaterial({ toneMapped: false }));
      scene.add(entry.cone);
    }
    tmpColor.copy(colorFor(entry.visual.color));
    tmpMix.copy(surface).lerp(tmpColor, entry.visual.opacity);
    entry.cone.material.color.copy(tmpMix);
  }

  /** Returns true when the connector changed batch key (width, dashed, lanes or march), which needs a buffer rebuild. */
  function restyleConnector(entry: ConnectorEntry): boolean {
    const previous = entry.visual;
    entry.visual = resolver.connectorVisual(entry.connector);
    entry.revision = entry.connector.revision;
    refreshCone(entry);
    return (
      previous.dashed !== entry.visual.dashed ||
      previous.width !== entry.visual.width ||
      previous.lanes !== entry.visual.lanes ||
      previous.marchSpeed !== entry.visual.marchSpeed
    );
  }

  /** Incident to the selected node: drawn wider and lighter, in its own batch. */
  function isSelectedConnector(entry: ConnectorEntry): boolean {
    return selectedId !== null && (entry.link.source.id === selectedId || entry.link.target.id === selectedId);
  }

  function connectorWidth(entry: ConnectorEntry): number {
    return entry.visual.width * (isSelectedConnector(entry) ? selectionStyle.widthScale : 1);
  }

  /** Both endpoints shown web nodes → drawn and simulated; a hidden endpoint or a spider endpoint drops the connector. */
  function classifyConnector(entry: ConnectorEntry): void {
    const source = entries.get(entry.connector.source);
    const target = entries.get(entry.connector.target);
    entry.active = source !== undefined && target !== undefined && source.mesh !== null && target.mesh !== null;
    refreshCone(entry);
  }

  function createConnectorEntry(connector: Connector, source: NodeEntry, target: NodeEntry): ConnectorEntry {
    const entry: ConnectorEntry = {
      connector,
      link: { id: connector.id, kind: connector.kind, distance: connector.distance, source: source.sim, target: target.sim },
      active: false,
      visual: resolver.connectorVisual(connector),
      revision: connector.revision,
      cone: null,
    };
    classifyConnector(entry);
    return entry;
  }

  function disposeConnectorEntry(entry: ConnectorEntry): void {
    if (entry.cone) {
      scene.remove(entry.cone);
      entry.cone.material.dispose();
    }
  }

  function groupConnector(
    grouped: Map<string, LineGroup>,
    entry: ConnectorEntry,
    width: number,
    lane: -1 | 0 | 1,
    velocity: number,
  ): void {
    const { dashed } = entry.visual;
    const key = `${width}|${dashed ? "d" : "s"}|${lane}|${velocity}`;
    let group = grouped.get(key);
    if (!group) grouped.set(key, (group = { width, dashed, lane, velocity, entries: [] }));
    group.entries.push(entry);
  }

  /**
   * Regroup every drawn connector into its `(width, dashed, lane, velocity)` batch(es) and resize
   * the batch buffers. A 2-lane connector lands in two batches: lane `+1` marching source→target
   * and lane `−1` marching back; a single lane marches forward (`marchSpeed > 0`) or is static.
   * Runs on structural/drawable changes, style changes and selection changes (the selected node's
   * connectors change width, hence batch); batches left without members are disposed.
   */
  function rebuildLineBuffers(): void {
    const grouped = new Map<string, LineGroup>();
    for (const e of connectorEntries.values()) {
      if (!e.active) continue;
      const width = connectorWidth(e);
      // Only dashed lines can march: a solid line's dash offset is never read.
      const speed = e.visual.dashed ? e.visual.marchSpeed : 0;
      if (e.visual.lanes === 2) {
        groupConnector(grouped, e, width, 1, speed);
        groupConnector(grouped, e, width, -1, -speed);
      } else {
        groupConnector(grouped, e, width, 0, speed);
      }
    }
    for (const [key, batch] of lineBatches) {
      if (grouped.has(key)) continue;
      disposeLineBatch(batch);
      lineBatches.delete(key);
    }
    for (const [key, group] of grouped) {
      const batch = lineBatches.get(key);
      if (batch) {
        batch.entries = group.entries;
        resizeLineBatch(batch, group.entries.length);
      } else {
        lineBatches.set(key, createLineBatch(group));
      }
    }
    lineBatchList = [...lineBatches.values()];
    refreshLineColors();
  }

  function refreshLineColors(): void {
    for (const batch of lineBatchList) {
      const { entries: list, colors } = batch;
      for (let i = 0; i < list.length; i++) {
        const { visual } = list[i];
        let opacity = visual.opacity;
        tmpColor.copy(colorFor(visual.color));
        if (isSelectedConnector(list[i])) {
          tmpColor.lerp(foreground, selectionStyle.lighten);
          opacity = 1;
        }
        tmpMix.copy(surface).lerp(tmpColor, opacity);
        const o = i * 6;
        colors[o] = colors[o + 3] = tmpMix.r;
        colors[o + 1] = colors[o + 4] = tmpMix.g;
        colors[o + 2] = colors[o + 5] = tmpMix.b;
      }
      batch.colorBuffer.needsUpdate = true;
    }
  }

  /**
   * Write endpoint positions (and, for dashed batches, segment lengths) into the instanced buffers
   * in place. Lane batches (`lane ≠ 0`) shift the segment sideways by `±LANE_GAP × max(1, mean
   * endpoint radius)` along `normalize(dir × cameraForward)` — perpendicular to the segment and to
   * the view, so the two lanes stay side by side on screen (world Y when the segment points at the
   * camera) — and trim both ends to the sphere surfaces so the lanes run edge to edge.
   */
  function updateLinePositions(): void {
    camera.getWorldDirection(cameraForward);
    const fx = cameraForward.x;
    const fy = cameraForward.y;
    const fz = cameraForward.z;
    for (const batch of lineBatchList) {
      const { entries: list, positions, distances, lane } = batch;
      for (let i = 0; i < list.length; i++) {
        const { source, target } = list[i].link;
        const o = i * 6;
        let sx = source.x ?? 0;
        let sy = source.y ?? 0;
        let sz = source.z ?? 0;
        let tx = target.x ?? 0;
        let ty = target.y ?? 0;
        let tz = target.z ?? 0;
        const dx = tx - sx;
        const dy = ty - sy;
        const dz = tz - sz;
        let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (lane !== 0 && length > 1e-6) {
          const ux = dx / length;
          const uy = dy / length;
          const uz = dz / length;
          let nx = uy * fz - uz * fy;
          let ny = uz * fx - ux * fz;
          let nz = ux * fy - uy * fx;
          const n = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (n > 1e-6) {
            nx /= n;
            ny /= n;
            nz /= n;
          } else {
            nx = 0;
            ny = 1;
            nz = 0;
          }
          const gap = lane * LANE_GAP * Math.max(1, (source.radius + target.radius) / 2);
          const sr = source.radius;
          const tr = target.radius;
          sx += ux * sr + nx * gap;
          sy += uy * sr + ny * gap;
          sz += uz * sr + nz * gap;
          tx += nx * gap - ux * tr;
          ty += ny * gap - uy * tr;
          tz += nz * gap - uz * tr;
          length = Math.max(0, length - sr - tr);
        }
        positions[o] = sx;
        positions[o + 1] = sy;
        positions[o + 2] = sz;
        positions[o + 3] = tx;
        positions[o + 4] = ty;
        positions[o + 5] = tz;
        if (distances) {
          distances[i * 2] = 0;
          distances[i * 2 + 1] = length;
        }
      }
      batch.positionBuffer.needsUpdate = true;
      if (batch.distanceBuffer) batch.distanceBuffer.needsUpdate = true;
    }
  }

  /**
   * Advance each marching batch's dash pattern by `velocity × dt`. The shader samples
   * `distance + dashOffset`, so a growing offset moves dashes toward the source; subtract to march
   * along `velocity`'s sign. Wrapped to one dash period so the uniform never drifts. A running
   * spoke's lanes counter-march: lane `+` outward (toward the tip), lane `−` inward.
   */
  function marchDashes(dt: number): void {
    const [laneOut, laneIn] = laneMaterials.running;
    laneOut.dashOffset = (laneOut.dashOffset - SPOKE_LANE_SPEED * dt) % SPOKE_LANE_PERIOD;
    laneIn.dashOffset = (laneIn.dashOffset + SPOKE_LANE_SPEED * dt) % SPOKE_LANE_PERIOD;
    for (const batch of lineBatchList) {
      if (batch.velocity === 0) continue;
      batch.material.dashOffset = (batch.material.dashOffset - batch.velocity * dt) % DASH_PERIOD;
    }
  }

  // ---- agent rings ---------------------------------------------------------------------------
  /** A spider leaves the drawn set: its label (hover/select) goes with it. */
  function unplace(entry: NodeEntry): void {
    entry.placed = false;
    refreshLabel(entry);
  }

  function disposeAgentRingSet(set: AgentRingSet): void {
    for (const ring of set.rings) {
      scene.remove(ring.group);
      if (ring.material) disposeGlyphMaterial(ring.material);
      for (const spoke of ring.spokes) {
        spoke.lanes[0].geometry.dispose();
        spoke.lanes[1].geometry.dispose();
        if (spoke.material) disposeGlyphMaterial(spoke.material);
        unplace(spoke.entry);
      }
      unplace(ring.entry);
    }
  }

  /** Drop a per-object glyph material (executing ring, running tip) from the sweeps and the GPU. */
  function disposeGlyphMaterial(material: LineMaterialModule.LineMaterial): void {
    glyphMaterials.delete(material);
    material.dispose();
  }

  function agentRingRadius(anchor: NodeEntry, slot: number): number {
    return anchor.visual.radius * agentRingStyle.innerScale + slot * agentRingStyle.spacing;
  }

  /** Shown `agent` spider anchored to a web node, else undefined. */
  function agentSpider(id: string): NodeEntry | undefined {
    const entry = entries.get(id);
    return entry?.shown && entry.node instanceof AgentNode ? entry : undefined;
  }

  /** Shown `subagent` spider anchored to an agent, else undefined. */
  function subagentSpider(id: string): NodeEntry | undefined {
    const entry = entries.get(id);
    return entry?.shown && entry.node instanceof SubagentNode ? entry : undefined;
  }

  /** Scratch for one anchor's reconcile/build: paseo agent id → shown agent spider on that anchor (`indexAnchorAgents`). */
  const anchorAgents = new Map<string, NodeEntry>();
  /** Scratch: the spokes of one ring in draw order (`collectSpokes`), entry and look side by side. */
  const spokeEntries: NodeEntry[] = [];
  const spokeLooks: SpokeLook[] = [];

  function indexAnchorAgents(spiderIds: string[]): void {
    anchorAgents.clear();
    for (const id of spiderIds) {
      const agent = agentSpider(id);
      if (agent) anchorAgents.set((agent.node as AgentNode).agentId, agent);
    }
  }

  /**
   * Root of `agent`'s parent chain on its own checkout: an agent whose `parentAgentId` is another
   * shown agent there (`anchorAgents`) is a child context, drawn as a spoke on the root's ring;
   * only roots get rings. Hops are bounded by the index size so a cyclic chain still terminates.
   */
  function rootAgent(agent: NodeEntry): NodeEntry {
    let root = agent;
    for (let hops = anchorAgents.size; hops > 0; hops--) {
      const parentId = (root.node as AgentNode).parentAgentId;
      const parent = parentId === undefined ? undefined : anchorAgents.get(parentId);
      if (!parent || parent === root) break;
      root = parent;
    }
    return root;
  }

  /**
   * Fill `spokeEntries`/`spokeLooks` with `root`'s spokes in stable order: walking the anchor's
   * spiders (sorted), each agent in `root`'s tree contributes itself (child agents only; the root
   * is the ring) and then its anchored subagents in sorted order.
   */
  function collectSpokes(root: NodeEntry, spiderIds: string[]): void {
    spokeEntries.length = 0;
    spokeLooks.length = 0;
    for (const id of spiderIds) {
      const agent = agentSpider(id);
      if (!agent || rootAgent(agent) !== root) continue;
      if (agent !== root) {
        spokeEntries.push(agent);
        spokeLooks.push(AGENT_SPOKE_LOOK[(agent.node as AgentNode).state]);
      }
      const subIds = anchoredBy.get(id);
      if (!subIds) continue;
      for (const subId of subIds) {
        const sub = subagentSpider(subId);
        if (!sub) continue;
        spokeEntries.push(sub);
        spokeLooks.push((sub.node as SubagentNode).state);
      }
    }
  }

  /**
   * Reconcile the ring sets with the anchored-spider index: one set per shown web node that has
   * anchored `agent` spiders, one ring per root agent (`rootAgent`) in sorted id order, concentric
   * from `radius × innerScale` outward by `spacing`, and on each ring one spoke per child agent and
   * subagent of that tree (`collectSpokes`). A set is rebuilt only when its reconcile key
   * (`AgentRingSet.key`) differs from what is drawn, so state changes are cheap and untouched sets
   * keep their objects. Runs after `rebuildAnchorIndex` and after node restyles; refreshes the
   * pickable list.
   */
  function rebuildAgentRings(): void {
    agentRingsDirty = false;
    const keep = new Set<string>();
    if (agentRingStyle.show) {
      for (const [anchorId, spiderIds] of anchoredBy) {
        const anchor = entries.get(anchorId);
        if (!anchor?.mesh) continue;
        const spokeLength = anchor.visual.radius * agentRingStyle.spokeScale;
        const tipRadius = anchor.visual.radius * agentRingStyle.spokeTipScale;
        let key = `${spokeLength}|${tipRadius}|${agentRingStyle.spokeLaneGap}`;
        indexAnchorAgents(spiderIds);
        let count = 0;
        for (const id of spiderIds) {
          const agent = agentSpider(id);
          if (!agent || rootAgent(agent) !== agent) continue;
          key += `;${id}|${(agent.node as AgentNode).state === "executing" ? 1 : 0}|${agentRingRadius(anchor, count++)}`;
          collectSpokes(agent, spiderIds);
          for (let i = 0; i < spokeEntries.length; i++) key += `,${spokeEntries[i].node.id}|${spokeLooks[i]}`;
        }
        if (count === 0) continue;
        keep.add(anchorId);
        const existing = agentRingSets.get(anchorId);
        if (existing && existing.entry === anchor && existing.key === key) continue;
        if (existing) disposeAgentRingSet(existing);
        agentRingSets.set(anchorId, createAgentRingSet(anchor, spiderIds, key, spokeLength, tipRadius, existing?.spokesHidden ?? false));
      }
    }
    for (const [anchorId, set] of agentRingSets) {
      if (keep.has(anchorId)) continue;
      disposeAgentRingSet(set);
      agentRingSets.delete(anchorId);
    }
    rebuildPickables();
  }

  /** Build the set for `anchor` (`anchorAgents` indexed for `spiderIds` by the caller), inheriting the spoke LOD state of the set it replaces. */
  function createAgentRingSet(
    anchor: NodeEntry,
    spiderIds: string[],
    key: string,
    spokeLength: number,
    tipRadius: number,
    spokesHidden: boolean,
  ): AgentRingSet {
    const set: AgentRingSet = { entry: anchor, key, rings: [], spokesHidden };
    for (const id of spiderIds) {
      const agent = agentSpider(id);
      if (!agent || rootAgent(agent) !== agent) continue;
      const material = (agent.node as AgentNode).state === "executing" ? createRingMaterial(id === selectedId) : null;
      const radius = agentRingRadius(anchor, set.rings.length);
      const group = new THREE.Group();
      const line = new Line2(agentRingGeometry, material ?? solidRingMaterials[id === selectedId ? 1 : 0]);
      line.frustumCulled = false;
      line.renderOrder = AGENT_RING_RENDER_ORDER;
      line.scale.setScalar(radius);
      line.userData.id = id;
      group.add(line);
      const ring: AgentRing = { entry: agent, radius, group, line, material, dashes: 0, spokes: [] };
      collectSpokes(agent, spiderIds);
      const slots = Math.max(spokeEntries.length, SPOKE_MIN_SLOTS);
      for (let i = 0; i < spokeEntries.length; i++) {
        const spoke = createSpoke(ring, spokeEntries[i], spokeLooks[i], spokeLength, tipRadius, i, slots);
        setSpokeShown(spoke, !spokesHidden);
        ring.spokes.push(spoke);
      }
      scene.add(group);
      agent.placed = true;
      refreshLabel(agent);
      set.rings.push(ring);
    }
    return set;
  }

  /**
   * Spoke `index` of `slots` on `ring`, in the ring's local plane, at angle `π/2 + index × 2π/slots`
   * (slot 0 at the top; fixed, the ring's spin is on the ring line only): a tip ring of `tipRadius`
   * centred `spokeLength` beyond the ring, joined to it by two lanes `±spokeLaneGap` either side of
   * the radial centre line. A lane offset `g` from a circle's centre line meets a circle of radius
   * `R` at `√(R² − g²)` along the line, so the lanes run from `√(r² − g²)` on the ring to
   * `outer − √(tipRadius² − g²)` on the tip and touch both edges exactly.
   */
  function createSpoke(
    ring: AgentRing,
    entry: NodeEntry,
    look: SpokeLook,
    spokeLength: number,
    tipRadius: number,
    index: number,
    slots: number,
  ): Spoke {
    const angle = Math.PI / 2 + (index / slots) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const outer = ring.radius + spokeLength;
    const gap = agentRingStyle.spokeLaneGap;
    const start = Math.sqrt(Math.max(ring.radius * ring.radius - gap * gap, 0));
    const end = outer - Math.sqrt(Math.max(tipRadius * tipRadius - gap * gap, 0));
    const lanes = [
      createLane(cos, sin, gap, start, end, laneMaterials[look][0]),
      createLane(cos, sin, -gap, start, end, laneMaterials[look][1]),
    ] as const;
    const material = look === "running" ? createTipMaterial() : null;
    const tip = new Line2(agentRingGeometry, material ?? tipMaterials[look]);
    tip.frustumCulled = false;
    tip.renderOrder = AGENT_RING_RENDER_ORDER;
    tip.position.set(cos * outer, sin * outer, 0);
    tip.scale.setScalar(tipRadius);
    tip.userData.id = entry.node.id;
    ring.group.add(lanes[0], lanes[1], tip);
    return { entry, look, tipRadius, lanes, tip, material, dashes: 0 };
  }

  /**
   * One spoke lane: the segment `[start, end]` along the spoke direction `(cos, sin)`, shifted
   * `offset` along its left normal `(−sin, cos)`. Dash distances are world units from the ring
   * end, so every lane's pattern starts at the ring and `dashOffset` marches it along the spoke.
   */
  function createLane(
    cos: number,
    sin: number,
    offset: number,
    start: number,
    end: number,
    material: LineMaterialModule.LineMaterial,
  ): Line2Module.Line2 {
    const nx = -sin * offset;
    const ny = cos * offset;
    const geometry = new LineGeometry();
    geometry.setPositions([cos * start + nx, sin * start + ny, 0, cos * end + nx, sin * end + ny, 0]);
    attachLineDistances(geometry, new Float32Array([0, end - start]), THREE.StaticDrawUsage);
    const lane = new Line2(geometry, material);
    lane.frustumCulled = false;
    lane.renderOrder = AGENT_RING_RENDER_ORDER;
    return lane;
  }

  /** Glyph LOD: a hidden spoke is neither drawn, picked (`pick` skips invisible hits) nor labelled. */
  function setSpokeShown(spoke: Spoke, shown: boolean): void {
    spoke.lanes[0].visible = shown;
    spoke.lanes[1].visible = shown;
    spoke.tip.visible = shown;
    spoke.entry.placed = shown;
    refreshLabel(spoke.entry);
  }

  /** Flip a set's spoke LOD: spokes and tips show or hide together; the rings are untouched. */
  function setSpokesShown(set: AgentRingSet, shown: boolean): void {
    set.spokesHidden = !shown;
    for (const ring of set.rings) for (const spoke of ring.spokes) setSpokeShown(spoke, shown);
  }

  /**
   * Retile a dashed glyph material (executing ring, running tip) to the dash count for its on-screen
   * radius: `clamp(round(2π·radiusPx / RING_DASH_PX), RING_DASHES_MIN, RING_DASHES_MAX)`, dash and
   * gap each `perimeter / (2 × count)` in the unit circle's distance space. `dashes` is the count
   * currently applied; the uniforms are touched only when the integer count changes.
   */
  function fitDashes(material: LineMaterialModule.LineMaterial, dashes: number, radiusPx: number): number {
    const count = Math.min(RING_DASHES_MAX, Math.max(RING_DASHES_MIN, Math.round((Math.PI * 2 * radiusPx) / RING_DASH_PX)));
    if (count !== dashes) {
      const dash = agentRingPerimeter / (count * 2);
      material.dashSize = dash;
      material.gapSize = dash;
    }
    return count;
  }

  /** Web node meshes first (nearest hit wins), then tips before rings so a tip crossing an outer ring picks as the tip on ties. */
  function rebuildPickables(): void {
    pickables.length = 0;
    for (const e of entries.values()) if (e.mesh) pickables.push(e.mesh);
    for (const set of agentRingSets.values()) {
      for (const ring of set.rings) for (const spoke of ring.spokes) pickables.push(spoke.tip);
    }
    for (const set of agentRingSets.values()) for (const ring of set.rings) pickables.push(ring.line);
  }

  /**
   * Selection or style changed: a solid ring takes the shared material for its selection state; an
   * executing ring's own material takes the matching width; a running tip's own material takes the
   * (restyled) lightened ring colour.
   */
  function refreshRingMaterials(): void {
    for (const set of agentRingSets.values()) {
      for (const ring of set.rings) {
        const selected = ring.entry.node.id === selectedId;
        if (ring.material) ring.material.linewidth = agentRingStyle.width * (selected ? selectionStyle.widthScale : 1);
        else ring.line.material = solidRingMaterials[selected ? 1 : 0];
        for (const spoke of ring.spokes) spoke.material?.color.copy(tipMaterials.running.color);
      }
    }
  }

  /** Style change: shared materials take the new width/colours; radii, spoke scales and `show` go through the reconcile; per-object materials are re-derived. */
  function restyleAgentRings(): void {
    restyleGlyphMaterials();
    rebuildAgentRings();
    refreshRingMaterials();
  }

  /**
   * Lay out `entry`'s label (if visible) at world point `(x, y, z)`, keeping `radius` world units
   * of silhouette clear on the anchored side. `unitPx` is this frame's px per view unit; under
   * perspective the silhouette is measured at the point's own depth, so 3D labels hug near and far
   * glyphs alike.
   */
  function layoutLabel(
    entry: NodeEntry,
    x: number,
    y: number,
    z: number,
    radius: number,
    anchor: LabelAnchor,
    perspective: boolean,
    unitPx: number,
  ): void {
    const label = entry.label;
    if (!label?.sprite.visible) return;
    label.sprite.position.set(x, y, z);
    const pxPerUnit = perspective
      ? unitPx / Math.max(-labelTmp.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z, 1e-3)
      : unitPx;
    labelLayout.fontPx = entry.sim.lod.fontPx;
    labelLayout.anchor = anchor;
    labelLayout.clearancePx = radius * pxPerUnit + labelSettings.offsetPx;
    label.layout(labelLayout);
  }

  /**
   * Per frame: each ring group follows its node and faces the camera in 3D (flat in 2D); executing
   * ring lines and running tips spin about the ring normal; running tips pulse. Agent labels sit
   * above the ring's top point, subagent labels at the tip.
   *
   * Screen-space minimum: the inner ring's on-screen radius (`unitPx`, divided by view depth under
   * perspective as for labels) is held at `minRadiusPx` or more by scaling the whole set
   * (`group.scale = minRadiusPx / innerPx` when under, else 1), so concentric rings keep their
   * spacing ratio and an executing ring stays visibly dashed and spinning at any zoom. Executing
   * rings and running tips retile their dashes to their clamped on-screen size (`fitDashes`).
   * Spoke LOD per set: spokes and tips hide while the (unclamped) inner ring is under
   * `minRadiusPx × SPOKE_SHOW_SCALE` with `GLYPH_LOD_HYSTERESIS`; flips go through
   * `setSpokesShown` so visibility changes only then. Spokes are only ever shown at scale 1, since
   * that band lies above `minRadiusPx`.
   */
  function updateAgentRings(time: number, perspective: boolean, unitPx: number): void {
    const spin = ((time / 1000) * agentRingStyle.rotateDegPerSec * THREE.MathUtils.DEG2RAD) % (Math.PI * 2);
    const billboard = mode === "3d-hub";
    const tipPulse = 1 + TIP_PULSE * (0.5 + 0.5 * Math.sin((time / PULSE_PERIOD_MS) * Math.PI * 2));
    const minPx = agentRingStyle.minRadiusPx;
    const spokePx = minPx * SPOKE_SHOW_SCALE;
    for (const set of agentRingSets.values()) {
      const { sim } = set.entry;
      const x = sim.x ?? 0;
      const y = sim.y ?? 0;
      const z = sim.z ?? 0;
      const pxPerUnit = perspective
        ? unitPx / Math.max(-glyphTmp.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z, 1e-3)
        : unitPx;
      const innerPx = set.rings[0].radius * pxPerUnit;
      const scale = innerPx < minPx ? minPx / innerPx : 1;
      if (set.spokesHidden ? innerPx > spokePx * (1 + GLYPH_LOD_HYSTERESIS) : innerPx < spokePx * (1 - GLYPH_LOD_HYSTERESIS)) {
        setSpokesShown(set, set.spokesHidden);
      }
      const spokesHidden = set.spokesHidden;
      for (const ring of set.rings) {
        const { group, line } = ring;
        group.position.set(x, y, z);
        group.scale.setScalar(scale);
        if (billboard) group.quaternion.copy(camera.quaternion);
        else group.quaternion.identity();
        if (ring.material) {
          line.quaternion.setFromAxisAngle(agentRingAxis, spin);
          ring.dashes = fitDashes(ring.material, ring.dashes, ring.radius * scale * pxPerUnit);
        }
        if (ring.entry.label?.sprite.visible) {
          glyphTmp.set(0, ring.radius * scale, 0).applyQuaternion(group.quaternion).add(group.position);
          layoutLabel(ring.entry, glyphTmp.x, glyphTmp.y, glyphTmp.z, 0, "above", perspective, unitPx);
        }
        if (spokesHidden) continue; // spokes hidden and unplaced: nothing to spin, pulse or label
        for (const spoke of ring.spokes) {
          const { tip } = spoke;
          if (spoke.material) {
            tip.quaternion.setFromAxisAngle(agentRingAxis, spin);
            tip.scale.setScalar(spoke.tipRadius * tipPulse);
            spoke.dashes = fitDashes(spoke.material, spoke.dashes, spoke.tipRadius * pxPerUnit);
          }
          if (spoke.entry.label?.sprite.visible) {
            glyphTmp.copy(tip.position).applyQuaternion(group.quaternion).add(group.position);
            layoutLabel(spoke.entry, glyphTmp.x, glyphTmp.y, glyphTmp.z, spoke.tipRadius, spoke.entry.visual.labelAnchor, perspective, unitPx);
          }
        }
      }
    }
  }

  /** Place each arrowhead on the segment, tip touching the target sphere. */
  function updateCones(): void {
    for (const entry of connectorEntries.values()) {
      const cone = entry.cone;
      if (!cone) continue;
      const { source, target } = entry.link;
      tmpDir.set((target.x ?? 0) - (source.x ?? 0), (target.y ?? 0) - (source.y ?? 0), (target.z ?? 0) - (source.z ?? 0));
      const length = tmpDir.length();
      if (length < 1e-6) {
        cone.visible = false;
        continue;
      }
      cone.visible = true;
      tmpDir.divideScalar(length);
      const back = target.radius + CONE_HEIGHT / 2;
      cone.position.set((target.x ?? 0) - tmpDir.x * back, (target.y ?? 0) - tmpDir.y * back, (target.z ?? 0) - tmpDir.z * back);
      cone.quaternion.setFromUnitVectors(coneUp, tmpDir);
    }
  }

  /** Rebuild what depends on the set of drawn objects without touching the web simulation. */
  function refreshDrawables(): void {
    for (const e of connectorEntries.values()) classifyConnector(e);
    rebuildAnchorIndex();
    rebuildClusters();
    rebuildLineBuffers();
  }

  // ---- cluster hulls -------------------------------------------------------------------------
  const clusterDrawables = new Map<string, ClusterDrawable>();
  /** Hull geometry follows positions; refreshed only on frames where something moved (or the set/style changed). */
  let hullsDirty = true;

  function createClusterDrawable(cluster: Cluster<SimNode>): ClusterDrawable {
    const flat = mode !== "3d-hub";
    const fillMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      // 3D: back faces only, so the far half tints the cluster interior and the near half never covers it.
      side: flat ? THREE.DoubleSide : THREE.BackSide,
    });
    let drawable: ClusterDrawable;
    if (flat) {
      // Hull as a triangle fan (convex, so vertex 0 fans the whole polygon) over a shared position
      // attribute; both draw ranges follow the vertex count from `clusterHull2d`.
      const capacity = cluster.extent.length * HULL_SAMPLES;
      const positions = new Float32Array(capacity * 3);
      const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
      const index = new Uint32Array(Math.max(0, capacity - 2) * 3);
      for (let i = 0; i + 2 < capacity; i++) {
        index[i * 3 + 1] = i + 1;
        index[i * 3 + 2] = i + 2;
      }
      const fillGeometry = new THREE.BufferGeometry();
      fillGeometry.setAttribute("position", positionAttribute);
      fillGeometry.setIndex(new THREE.BufferAttribute(index, 1));
      const outlineGeometry = new THREE.BufferGeometry();
      outlineGeometry.setAttribute("position", positionAttribute);
      const outline = new THREE.LineLoop(
        outlineGeometry,
        new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      outline.frustumCulled = false;
      outline.renderOrder = HULL_EDGE_RENDER_ORDER;
      hullScene.add(outline);
      drawable = {
        cluster,
        fill: new THREE.Mesh(fillGeometry, fillMaterial),
        outline,
        wire: null,
        hull: new Float32Array(capacity * 2),
        positions,
      };
    } else {
      const wire = new THREE.Mesh(
        sphereGeometry,
        new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      wire.frustumCulled = false;
      wire.renderOrder = HULL_EDGE_RENDER_ORDER;
      hullScene.add(wire);
      drawable = {
        cluster,
        fill: new THREE.Mesh(sphereGeometry, fillMaterial),
        outline: null,
        wire,
        hull: new Float32Array(0),
        positions: new Float32Array(0),
      };
    }
    drawable.fill.frustumCulled = false;
    hullScene.add(drawable.fill);
    restyleClusterDrawable(drawable);
    return drawable;
  }

  function disposeClusterDrawable(drawable: ClusterDrawable): void {
    hullScene.remove(drawable.fill);
    drawable.fill.material.dispose();
    if (drawable.outline) {
      // Flat hulls own their geometry; 3D hulls share `sphereGeometry` with the nodes.
      drawable.fill.geometry.dispose();
      hullScene.remove(drawable.outline);
      drawable.outline.geometry.dispose();
      drawable.outline.material.dispose();
    }
    if (drawable.wire) {
      hullScene.remove(drawable.wire);
      drawable.wire.material.dispose();
    }
  }

  /** One drawable per non-root cluster, matching the current mode's geometry; called whenever clusters or mode change. */
  function rebuildClusterDrawables(): void {
    for (const drawable of clusterDrawables.values()) disposeClusterDrawable(drawable);
    clusterDrawables.clear();
    for (const cluster of clusters) {
      if (cluster.id === ROOT_CLUSTER || cluster.members.length === 0) continue;
      clusterDrawables.set(cluster.id, createClusterDrawable(cluster));
    }
    hullsDirty = true;
  }

  function restyleClusterDrawable(drawable: ClusterDrawable): void {
    const color = colorFor(clusterStyle.color);
    drawable.fill.material.color.copy(color);
    drawable.fill.material.opacity = clusterStyle.opacity;
    drawable.fill.visible = clusterStyle.show;
    if (drawable.outline) {
      drawable.outline.material.color.copy(color);
      drawable.outline.material.opacity = Math.min(1, clusterStyle.opacity * HULL_OUTLINE_OPACITY);
      drawable.outline.visible = clusterStyle.show;
    }
    if (drawable.wire) {
      drawable.wire.material.color.copy(color);
      drawable.wire.material.opacity = clusterStyle.opacity * HULL_WIRE_OPACITY;
      drawable.wire.visible = clusterStyle.show;
    }
  }

  /** Refit every hull to its cluster's current positions (after the tick and spider placement). */
  function updateClusterHulls(): void {
    const padding = clusterStyle.padding;
    for (const drawable of clusterDrawables.values()) {
      const { cluster, fill, outline, wire } = drawable;
      if (outline) {
        const count = clusterHull2d(cluster, padding, drawable.hull);
        const { hull, positions } = drawable;
        for (let i = 0; i < count; i++) {
          positions[i * 3] = hull[i * 2];
          positions[i * 3 + 1] = hull[i * 2 + 1];
          positions[i * 3 + 2] = 0;
        }
        const attribute = fill.geometry.getAttribute("position");
        if (attribute) attribute.needsUpdate = true;
        fill.geometry.setDrawRange(0, Math.max(0, count - 2) * 3);
        outline.geometry.setDrawRange(0, count);
        fill.visible = outline.visible = clusterStyle.show && count >= 3;
      } else if (wire) {
        measureCluster(cluster, padding, "xyz");
        fill.visible = wire.visible = clusterStyle.show && cluster.r > 0;
        fill.position.set(cluster.x, cluster.y, cluster.z);
        fill.scale.setScalar(cluster.r);
        wire.position.copy(fill.position);
        wire.scale.setScalar(cluster.r);
      }
    }
  }

  // ---- model subscription --------------------------------------------------------------------
  /**
   * Apply a batch of model changes; only the listed ids are touched. Web changes re-sync the
   * simulation; spider-only changes just rebuild the drawables so the web layout stays put.
   */
  function applyChanges(changes: readonly GraphChange[]): void {
    const wasEmpty = entries.size === 0;
    let structural = false;
    let drawables = false;
    let added = false;
    let recolor = false;

    for (const change of changes) {
      if (change.type === "node") {
        if (change.op === "remove") {
          const entry = entries.get(change.id);
          if (!entry) continue;
          unmountNode(entry);
          entries.delete(change.id);
          if (change.id === selectedId) setSelected(null);
          if (change.id === hoveredId) setHovered(null);
          if (entry.node.layer === "web") structural = true;
          else drawables = true;
          continue;
        }
        const node = graph.nodes.get(change.id);
        if (!node) continue;
        const existing = entries.get(change.id);
        if (existing) {
          if (existing.revision !== node.revision && restyleNode(existing)) {
            if (node.layer === "web") structural = true;
            else drawables = true;
          }
        } else {
          entries.set(node.id, createEntry(node));
          if (node.layer === "web") {
            structural = true;
            added = true;
          } else {
            drawables = true;
          }
        }
        continue;
      }
      if (change.op === "remove") {
        const entry = connectorEntries.get(change.id);
        if (!entry) continue;
        disposeConnectorEntry(entry);
        connectorEntries.delete(change.id);
        if (entry.active) structural = true;
        else drawables = true;
        continue;
      }
      const connector = graph.connectors.get(change.id);
      if (!connector) continue;
      const existing = connectorEntries.get(change.id);
      if (existing) {
        if (existing.revision !== connector.revision) {
          if (restyleConnector(existing)) drawables = true;
          recolor = true;
        }
        continue;
      }
      const source = entries.get(connector.source);
      const target = entries.get(connector.target);
      if (!source || !target) continue;
      const entry = createConnectorEntry(connector, source, target);
      connectorEntries.set(connector.id, entry);
      if (entry.active) structural = true;
      else drawables = true;
    }

    if (structural) {
      syncSimulation();
      simulation.alpha(Math.max(simulation.alpha(), wasEmpty || added ? 1 : 0.6));
      if (wasEmpty && entries.size > 0) fitPending = true;
    } else if (drawables) {
      refreshDrawables();
      if (wasEmpty && entries.size > 0) fitPending = true;
    } else if (recolor) {
      refreshLineColors();
    }
    // Structural/drawable paths reconcile via `rebuildAnchorIndex`; a bare agent state change lands here.
    if (agentRingsDirty) rebuildAgentRings();
  }

  // ---- picking -------------------------------------------------------------------------------
  const listeners = new Set<(event: GraphEvent) => void>();
  const raycaster = new THREE.Raycaster();
  // Rings and tips are picked through `LineSegments2.raycast`, which tests the fat line in screen
  // space (`worldUnits: false`) against `material.resolution` with `linewidth + threshold` px of hit width.
  raycaster.params.Line2 = { threshold: PICK_LINE_THRESHOLD_PX };
  const pointerNdc = new THREE.Vector2();
  let pointerDown: { x: number; y: number } | null = null;

  function emit(event: GraphEvent): void {
    for (const listener of listeners) listener(event);
  }

  /** Nearest hit among spheres, tip rings and agent rings; the object's `userData.id` is the node (web, subagent or agent) it stands for. */
  function pick(event: PointerEventLike): string | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    pointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    for (const hit of hits) if (hit.object.visible) return hit.object.userData.id as string;
    return null;
  }

  function setHovered(id: string | null): void {
    if (id === hoveredId) return;
    const previous = hoveredId ? entries.get(hoveredId) : undefined;
    hoveredId = id;
    if (previous) {
      refreshMaterial(previous);
      refreshLabel(previous);
    }
    const current = id ? entries.get(id) : undefined;
    if (current) {
      refreshMaterial(current);
      refreshLabel(current);
    }
    canvas.style.cursor = id ? "pointer" : "";
    emit({ type: "hover", id });
  }

  function setSelected(id: string | null): void {
    if (id === selectedId) return;
    const previous = selectedId ? entries.get(selectedId) : undefined;
    selectedId = id;
    if (previous) {
      refreshMaterial(previous);
      refreshLabel(previous);
    }
    const current = id ? entries.get(id) : undefined;
    if (current) {
      refreshMaterial(current);
      refreshLabel(current);
    }
    // The selected node's connectors change width, hence batch: regroup rather than just recolour.
    rebuildLineBuffers();
    refreshRingMaterials();
    emit({ type: "select", id });
  }

  const onPointerMove: PointerListener = (event) => {
    setHovered(pick(event));
  };
  const onPointerDown: PointerListener = (event) => {
    pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp: PointerListener = (event) => {
    if (!pointerDown) return;
    const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    pointerDown = null;
    if (moved > CLICK_SLOP_PX) return;
    setSelected(pick(event));
  };
  const onPointerLeave: PointerListener = () => {
    pointerDown = null;
    setHovered(null);
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  // ---- fit -----------------------------------------------------------------------------------
  const fitCenter = new THREE.Vector3();
  const fitDir = new THREE.Vector3();

  function fit(): void {
    if (entries.size === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    /** Shown nodes (plus label headroom) and visible hulls as spheres to frame. */
    const spheres: Array<{ x: number; y: number; z: number; r: number }> = [];
    for (const e of entries.values()) {
      if (!e.mesh?.visible || e.sim.x === undefined) continue;
      spheres.push({ x: e.sim.x, y: e.sim.y ?? 0, z: e.sim.z ?? 0, r: e.sim.radius + LABEL_FIT_HEADROOM });
    }
    if (clusterStyle.show) {
      const axes: ClusterAxes = mode === "3d-hub" ? "xyz" : "xy";
      for (const { cluster } of clusterDrawables.values()) {
        measureCluster(cluster, clusterStyle.padding, axes);
        if (cluster.r > 0) spheres.push({ x: cluster.x, y: cluster.y, z: cluster.z, r: cluster.r });
      }
    }
    if (spheres.length === 0) return;
    for (const s of spheres) {
      if (s.x - s.r < minX) minX = s.x - s.r;
      if (s.x + s.r > maxX) maxX = s.x + s.r;
      if (s.y - s.r < minY) minY = s.y - s.r;
      if (s.y + s.r > maxY) maxY = s.y + s.r;
      if (s.z - s.r < minZ) minZ = s.z - s.r;
      if (s.z + s.r > maxZ) maxZ = s.z + s.r;
    }
    fitCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let radius = 1;
    for (const s of spheres) {
      const dx = s.x - fitCenter.x;
      const dy = s.y - fitCenter.y;
      const dz = s.z - fitCenter.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + s.r;
      if (r > radius) radius = r;
    }
    radius *= FIT_MARGIN;

    if (camera instanceof THREE.PerspectiveCamera) {
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);
      fitDir.copy(camera.position).sub(controls.target);
      if (fitDir.lengthSq() < 1e-6) fitDir.set(0, 0.2, 1);
      fitDir.normalize();
      controls.target.copy(fitCenter);
      camera.position.copy(fitCenter).addScaledVector(fitDir, distance);
      camera.near = CAMERA_NEAR;
      camera.far = CAMERA_FAR;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      // Frustum spans ±width/2 world units at zoom 1, so zoom = pixels / world extent.
      camera.zoom = Math.min(width, height) / (2 * radius);
      controls.target.set(fitCenter.x, fitCenter.y, 0);
      camera.position.set(fitCenter.x, fitCenter.y, ORTHO_DEPTH);
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  // ---- render loop ---------------------------------------------------------------------------
  renderer.setAnimationLoop((time: number) => {
    // Seconds since the last frame, capped so a throttled tab does not jump the dash march.
    const dt = Math.min((time - lastFrameTime) / 1000, MARCH_DT_MAX);
    lastFrameTime = time;
    let ticked = false;
    if (simulation.alpha() >= ALPHA_MIN) {
      simulation.tick();
      ticked = true;
    } else if (fitPending) {
      fitPending = false;
      fit();
    }
    if (clusterStyle.show && (ticked || hullsDirty)) {
      updateClusterHulls();
      hullsDirty = false;
    }
    // Settle the camera first so label metrics use this frame's view, not the previous one's.
    controls.update();
    camera.updateMatrixWorld();
    // projectionMatrix[1][1] is 1/tan(fov/2) (perspective) or 2·zoom/(top−bottom) (orthographic), so a
    // view-space length ℓ covers ℓ·m11·height/2 px — divided by view depth under perspective.
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const unitPx = (camera.projectionMatrix.elements[5] * height) / 2;
    // Orbit-target metric: the root cluster, and every cluster under an orthographic camera, where
    // `zoom` makes px per unit depth-independent and the LOD is therefore global by nature.
    const targetPxPerUnit = perspective ? unitPx / Math.max(camera.position.distanceTo(controls.target), 1e-3) : unitPx;
    const lodThreshold = labelSettings.allAbovePxPerUnit;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const lod = clusterLods[i];
      // Per-project metric under perspective: px per unit at the view depth of the cluster centroid,
      // so the project the camera closes in on grows its labels and switches tier before the others.
      const pxPerUnit =
        perspective && cluster.id !== ROOT_CLUSTER && centerCluster(cluster)
          ? unitPx / Math.max(-labelTmp.set(cluster.x, cluster.y, cluster.z).applyMatrix4(camera.matrixWorldInverse).z, 1e-3)
          : targetPxPerUnit;
      lod.fontPx = Math.min(
        labelSettings.maxFontSizePx,
        Math.max(labelSettings.fontSizePx, (labelSettings.fontSizePx * pxPerUnit) / labelSettings.referencePxPerUnit),
      );
      const wasAll = lod.lodAll;
      if (lod.lodAll && pxPerUnit < lodThreshold * (1 - LABEL_LOD_HYSTERESIS)) lod.lodAll = false;
      else if (!lod.lodAll && pxPerUnit > lodThreshold * (1 + LABEL_LOD_HYSTERESIS)) lod.lodAll = true;
      lod.flipped = lod.lodAll !== wasAll;
    }
    // Non-attenuated sprite scale is in view-space units at depth 1 (perspective) or world units (ortho): px / unitPx.
    labelLayout.scalePerPx = 1 / unitPx;
    const pulse = 1.06 + 0.06 * Math.sin((time / PULSE_PERIOD_MS) * Math.PI * 2);
    for (const entry of entries.values()) {
      const { sim, mesh, visual } = entry;
      if (sim.lod.flipped) refreshLabel(entry);
      if (!mesh?.visible) continue;
      const x = sim.x ?? 0;
      const y = sim.y ?? 0;
      const z = sim.z ?? 0;
      mesh.position.set(x, y, z);
      const scale = visual.pulse ? visual.radius * pulse : visual.radius;
      mesh.scale.setScalar(scale);
      if (entry.ring) {
        entry.ring.position.set(x, y, z);
        entry.ring.scale.setScalar(scale * RING_SCALE);
        // The torus lies in XY; in 3D turn it to face the camera so it stays an outline.
        if (mode === "3d-hub") entry.ring.quaternion.copy(camera.quaternion);
        else entry.ring.quaternion.identity();
      }
      // Silhouette from the base radius (not the pulse).
      layoutLabel(entry, x, y, z, visual.radius, visual.labelAnchor, perspective, unitPx);
    }
    updateLinePositions();
    marchDashes(dt);
    updateCones();
    updateAgentRings(time, perspective, unitPx);
    renderer.clear();
    renderer.render(hullScene, camera);
    renderer.render(scene, camera);
  });

  const gl = renderer.getContext() as unknown as GlContext;
  const glVersion = String(gl.getParameter(gl.VERSION));
  const info = `three r${THREE.REVISION}, ${glVersion}, d3-force-3d, ${width}x${height} @${window.devicePixelRatio}x`;

  // ---- initial state + subscription ----------------------------------------------------------
  const initial: GraphChange[] = [];
  for (const id of graph.nodes.keys()) initial.push({ type: "node", op: "add", id });
  for (const id of graph.connectors.keys()) initial.push({ type: "connector", op: "add", id });
  if (initial.length) applyChanges(initial);
  const unsubscribe = graph.subscribe(applyChanges);

  // ---- handle --------------------------------------------------------------------------------
  const handle: GraphHandle = {
    info,
    graph,

    setStyle(style: GraphStyle) {
      resolver = new StyleResolver(style);
      colorCache = new Map();
      selectionStyle = resolver.selectionVisual();
      agentRingStyle = resolver.agentRingVisual();
      const previousPadding = clusterStyle.padding;
      clusterStyle = resolver.clusterVisual();
      labelSettings = resolver.labels();
      // `restyleNode` → `refreshLabel` hands this to every label, which re-bakes only if it differs.
      labelStyle = { color: labelCss(), bakeFontSizePx: labelSettings.maxFontSizePx };
      let resimulate = previousPadding !== clusterStyle.padding;
      let drawablesChanged = false;
      for (const entry of entries.values()) {
        const previousRadius = entry.visual.radius;
        const flipped = restyleNode(entry);
        if (entry.node.layer === "web") {
          // Collision radii and the shown set feed the simulation; let it settle again.
          if (flipped || previousRadius !== entry.visual.radius) resimulate = true;
        } else if (flipped) {
          drawablesChanged = true;
        }
      }
      for (const entry of connectorEntries.values()) restyleConnector(entry);
      if (resimulate) {
        syncSimulation();
        simulation.alpha(Math.max(simulation.alpha(), 0.3));
      } else if (drawablesChanged) {
        refreshDrawables();
      } else {
        // Widths, dash flags, lanes, march speeds and the selection width scale are all batch keys: regroup unconditionally.
        rebuildLineBuffers();
      }
      restyleAgentRings();
      for (const drawable of clusterDrawables.values()) restyleClusterDrawable(drawable);
      hullsDirty = true;
    },

    setMode(next: GraphMode) {
      if (next === mode) return;
      const cameraChanges = (next === "3d-hub") !== (mode === "3d-hub");
      mode = next;
      if (cameraChanges) {
        controls.dispose();
        camera = createCamera(mode);
        controls = createControls(camera, mode);
      }
      simulation.numDimensions(mode === "3d-hub" ? 3 : 2);
      prepareLayout();
      simulation.nodes(nodeList);
      enforceDimensions();
      configureForces();
      rebuildClusterDrawables();
      simulation.alpha(1);
      // Frame the current positions now so the new camera is sane, and again once the layout settles.
      fit();
      fitPending = true;
    },

    relayout() {
      for (const n of nodeList) {
        delete n.x;
        delete n.y;
        delete n.z;
        delete n.vx;
        delete n.vy;
        delete n.vz;
      }
      rng = lcg(SEED);
      simulation.randomSource(lcg(SEED));
      // `2d-lr` seeds y per column here; hub modes leave positions to d3's deterministic placement.
      prepareLayout();
      // `nodes()` re-runs d3's initial placement for every node without a position.
      simulation.nodes(nodeList);
      enforceDimensions();
      simulation.alpha(1);
      fitPending = true;
    },

    fit,

    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      unsubscribe();
      renderer.setAnimationLoop(null);
      simulation.stop();
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      listeners.clear();
      controls.dispose();
      for (const entry of entries.values()) unmountNode(entry);
      for (const entry of connectorEntries.values()) disposeConnectorEntry(entry);
      for (const drawable of clusterDrawables.values()) disposeClusterDrawable(drawable);
      clusterDrawables.clear();
      for (const batch of lineBatches.values()) disposeLineBatch(batch);
      lineBatches.clear();
      lineBatchList = [];
      for (const set of agentRingSets.values()) disposeAgentRingSet(set);
      agentRingSets.clear();
      entries.clear();
      connectorEntries.clear();
      sphereGeometry.dispose();
      dodecahedronGeometry.dispose();
      dodecahedronClusterGeometry.dispose();
      ringGeometry.dispose();
      coneGeometry.dispose();
      agentRingGeometry.dispose();
      for (const material of glyphMaterials) material.dispose();
      pickables.length = 0;
      renderer.dispose();
      canvas.remove();
    },
  };
  // Non-contract debug hook: overlapping cluster pairs under the current mode's measure (0 once contained).
  return Object.assign(handle, { __debug: { clusterOverlaps } });
}
