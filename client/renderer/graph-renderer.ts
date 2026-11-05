import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import type { GraphEvent, GraphHandle, GraphMode } from "../../shared/graph";
import type { Connector } from "../../shared/model/connector";
import type { Graph, GraphChange } from "../../shared/model/graph";
import type { GraphNode } from "../../shared/model/node";
import { type GraphStyle, StyleResolver } from "../../shared/model/style";
import type { ColorRef, ColorRole, ConnectorVisual, LabelSettings, NodeVisual } from "../../shared/model/visual";
import { type ConnectorKind, TREE_CONNECTOR_KINDS } from "../../shared/model/wire";
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
}

/**
 * Position holder for one node, keyed by id and kept across model updates. Web nodes are d3
 * simulation nodes; spider nodes reuse the shape (so lines, labels and fit read one field set)
 * but are never handed to the simulation — their x/y/z are computed from their anchor each frame.
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
  /** Spider only: the anchor the current placement is based on; differs from `node.anchorId` → tween. */
  anchorId: string | undefined;
  /** Spider only: straight-line move from the old anchor to the new one. */
  tween: { from: Point; start: number } | null;
  /** Spider only: frame stamp of the last placement, so anchor chains resolve once per frame. */
  placedFrame: number;
  /** Null while `visual.hidden`: not drawn, not picked, not simulated. Ring and label follow it. */
  mesh: Three.Mesh<Three.SphereGeometry, Three.MeshStandardMaterial> | null;
  ring: Three.Mesh<Three.TorusGeometry, Three.MeshBasicMaterial> | null;
  label: Label | null;
}
interface ConnectorEntry {
  connector: Connector;
  link: SimLink;
  /** Both endpoints are shown web nodes → the link is a simulation force; otherwise only drawn. */
  simulated: boolean;
  /** Hidden endpoints hide the connector; `contains` into a spider is not drawn either: the spider already sits on its anchor. */
  drawn: boolean;
  visual: ConnectorVisual;
  revision: number;
  /** Arrowhead at the target when `visual.directed` and drawn. */
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
/** One `LineSegments` draw: solid or dashed connectors, each with its own interleaved buffers. */
interface LineBatch {
  geometry: Three.BufferGeometry;
  object: Three.LineSegments;
  entries: ConnectorEntry[];
  positions: Float32Array;
  colors: Float32Array;
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
const ORTHO_INITIAL_ZOOM = 8;
const CLICK_SLOP_PX = 4;
/** Ring radius as a multiple of the node radius; tube is thin so it reads as an outline. */
const RING_SCALE = 1.35;
const RING_TUBE = 0.05;
const CONE_HEIGHT = 0.7;
const CONE_RADIUS = 0.28;
const DASH_SIZE = 0.6;
const GAP_SIZE = 0.4;
const SELECT_EMISSIVE = 0.5;
const HOVER_EMISSIVE = 0.2;
/** Spider ring radius = anchor radius + spider radius × this. */
const SPIDER_ORBIT = 1.8;
/** Tilt of the spider ring out of the XY plane in `3d-hub`, radians. */
const SPIDER_TILT_3D = 0.45;
const SPIDER_TWEEN_MS = 600;

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
  const { THREE, OrbitControls, d3 } = libs;

  // ---- style / palette -----------------------------------------------------------------------
  let resolver = new StyleResolver(initialStyle);
  const surface = new THREE.Color(theme.colors.surface0);
  const foreground = new THREE.Color(theme.colors.foreground);
  /** Resolved `ColorRef` → colour; cleared when the style (and thus its palette) changes. */
  let colorCache = new Map<ColorRef, Three.Color>();

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
  const ringGeometry = new THREE.TorusGeometry(1, RING_TUBE, 8, 48);
  const coneGeometry = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 12);

  // Opacity per connector is pre-mixed into the vertex colours against the surface colour, so one
  // opaque draw call per batch carries every opacity. Dashed connectors need a different material,
  // hence a second batch; `computeLineDistances` runs on it every frame since endpoints move.
  const solidMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  const dashedMaterial = new THREE.LineDashedMaterial({ vertexColors: true, dashSize: DASH_SIZE, gapSize: GAP_SIZE });
  function createBatch(material: Three.Material): LineBatch {
    const geometry = new THREE.BufferGeometry();
    const object = new THREE.LineSegments(geometry, material);
    object.frustumCulled = false;
    scene.add(object);
    return { geometry, object, entries: [], positions: new Float32Array(0), colors: new Float32Array(0) };
  }
  const solid = createBatch(solidMaterial);
  const dashed = createBatch(dashedMaterial);

  // ---- camera / controls ---------------------------------------------------------------------
  let mode: GraphMode = initialMode;
  let camera: Three.Camera = createCamera(mode);
  let controls: OrbitControlsModule.OrbitControls = createControls(camera, mode);

  function createCamera(target: GraphMode): Three.Camera {
    if (target === "3d-hub") {
      const cam = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
      cam.position.set(0, CAMERA_3D_DISTANCE * 0.2, CAMERA_3D_DISTANCE);
      cam.lookAt(0, 0, 0);
      return cam;
    }
    const cam = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, ORTHO_DEPTH * 4);
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
      c.maxDistance = 1000;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    } else {
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      c.minZoom = 0.5;
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
  let meshes: Three.Object3D[] = [];
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

  /** Reassign every node's cluster and rebuild the cluster list (members: shown web nodes; extent: plus their spiders). */
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
      // Follow the anchor chain to a shown web node; a spider that resolves to nothing is not drawn.
      let anchor: NodeEntry | undefined = e;
      let hops = 0;
      while (anchor && anchor.node.layer === "spider" && anchor.mesh && hops++ <= entries.size) {
        anchor = anchor.anchorId !== undefined ? entries.get(anchor.anchorId) : undefined;
      }
      const web = anchor?.node.layer === "web" && anchor.mesh ? anchor : undefined;
      e.sim.clusterId = web ? web.sim.clusterId : ROOT_CLUSTER;
      e.sim.lod = lodFor(e.sim.clusterId);
      if (web && e.mesh) clusterFor(e.sim.clusterId).extent.push(e.sim);
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
    meshes = [];
    for (const e of entries.values()) {
      if (!e.mesh) continue;
      if (e.node.layer === "web") nodeList.push(e.sim);
      meshes.push(e.mesh);
    }
    linkList = [];
    for (const e of connectorEntries.values()) {
      classifyConnector(e);
      if (e.simulated) linkList.push(e.link);
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
  /** Anchor id → ids of the spiders riding on it, in stable (sorted) order; drives ring slots. */
  const anchoredBy = new Map<string, string[]>();
  let frame = 0;
  /** Timestamp of the last animation frame; tweens started between frames use it as their origin. */
  let lastFrameTime = 0;
  /** Set when a spider's position changed this frame, so hulls (which include spiders) refresh. */
  let spiderMoved = false;

  function rebuildAnchorIndex(): void {
    anchoredBy.clear();
    for (const e of entries.values()) {
      if (e.anchorId === undefined || !e.mesh) continue;
      let list = anchoredBy.get(e.anchorId);
      if (!list) anchoredBy.set(e.anchorId, (list = []));
      list.push(e.node.id);
    }
    for (const list of anchoredBy.values()) list.sort();
  }

  function spiderVisible(entry: NodeEntry, visible: boolean): void {
    if (!entry.mesh) return;
    entry.mesh.visible = visible;
    if (entry.ring) entry.ring.visible = visible;
    if (entry.label) entry.label.sprite.visible = visible && labelVisible(entry);
  }

  /**
   * Compute a spider's position for this frame: its ring slot around the anchor (anchor chains
   * resolve recursively, once per frame), blended from the previous anchor while a tween runs.
   */
  function placeSpider(entry: NodeEntry, time: number): void {
    if (entry.placedFrame === frame || !entry.mesh) return;
    entry.placedFrame = frame;
    const anchor = entry.anchorId !== undefined ? entries.get(entry.anchorId) : undefined;
    if (!anchor) {
      spiderVisible(entry, false);
      return;
    }
    if (anchor.node.layer === "spider") placeSpider(anchor, time);
    if (!anchor.mesh?.visible) {
      spiderVisible(entry, false);
      return;
    }
    spiderVisible(entry, true);
    const slots = anchoredBy.get(anchor.node.id);
    const count = slots?.length ?? 1;
    const index = slots?.indexOf(entry.node.id) ?? 0;
    const angle = Math.PI / 2 + (index / count) * Math.PI * 2;
    const r = anchor.visual.radius + entry.visual.radius * SPIDER_ORBIT;
    const tilt = mode === "3d-hub" ? SPIDER_TILT_3D : 0;
    const ax = anchor.sim.x ?? 0;
    const ay = anchor.sim.y ?? 0;
    const az = anchor.sim.z ?? 0;
    let x = ax + Math.cos(angle) * r;
    let y = ay + Math.sin(angle) * r * Math.cos(tilt);
    let z = az + Math.sin(angle) * r * Math.sin(tilt);
    const tween = entry.tween;
    if (tween) {
      const t = (time - tween.start) / SPIDER_TWEEN_MS;
      if (t >= 1) {
        entry.tween = null;
      } else {
        const s = t * t * (3 - 2 * t);
        x = tween.from.x + (x - tween.from.x) * s;
        y = tween.from.y + (y - tween.from.y) * s;
        z = tween.from.z + (z - tween.from.z) * s;
      }
    }
    if (entry.sim.x !== x || entry.sim.y !== y || entry.sim.z !== z) spiderMoved = true;
    entry.sim.x = x;
    entry.sim.y = y;
    entry.sim.z = z;
  }

  /** Spider anchor moved in the model: remember where it is now and slide to the new slot. */
  function retargetSpider(entry: NodeEntry, now: number): void {
    if (entry.sim.x !== undefined && entry.mesh?.visible) {
      entry.tween = { from: { x: entry.sim.x, y: entry.sim.y ?? 0, z: entry.sim.z ?? 0 }, start: now };
    }
    entry.anchorId = entry.node.anchorId;
    rebuildAnchorIndex();
    rebuildClusters();
  }

  // ---- node visuals --------------------------------------------------------------------------
  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  /** Hover/select always show; otherwise `labelAlways`, gated by the node's cluster zoom LOD for `all`-tier labels. */
  function labelVisible(entry: NodeEntry): boolean {
    const id = entry.node.id;
    if (id === selectedId || id === hoveredId) return true;
    return entry.visual.labelAlways && (entry.sim.lod.lodAll || entry.visual.labelTier === "project");
  }

  function refreshLabel(entry: NodeEntry): void {
    if (!entry.mesh || !labelVisible(entry)) {
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
    const color = colorFor(visual.color);
    mesh.material.color.copy(color);
    mesh.material.emissive.copy(color);
    let intensity = visual.emissive;
    if (node.id === selectedId) intensity += SELECT_EMISSIVE;
    if (node.id === hoveredId) intensity += HOVER_EMISSIVE;
    mesh.material.emissiveIntensity = intensity;
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

  /** Give a shown node its sphere; web nodes without a position start near an anchor so they do not fly in from the origin. */
  function mountNode(entry: NodeEntry): void {
    const { node, sim, visual } = entry;
    // Without an anchor, leave the position undefined and let d3's deterministic phyllotaxis
    // placement handle it. Spiders are placed from their anchor every frame.
    const anchor = node.layer === "web" && sim.x === undefined ? anchorFor(node) : null;
    if (anchor) {
      const angle = rng() * Math.PI * 2;
      const r = SPAWN_RADIUS * (0.5 + rng() * 0.5);
      sim.x = anchor.x + Math.cos(angle) * r;
      sim.y = anchor.y + Math.sin(angle) * r;
      sim.z = mode === "3d-hub" ? anchor.z + (rng() - 0.5) * r : 0;
    }
    const mesh = new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }));
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
   * Returns true when `hidden` flipped: the node entered or left the drawn/simulated set.
   */
  function restyleNode(entry: NodeEntry): boolean {
    entry.visual = resolver.nodeVisual(entry.node);
    entry.revision = entry.node.revision;
    entry.sim.radius = entry.visual.radius;
    const flipped = entry.visual.hidden === (entry.mesh !== null);
    if (flipped) {
      if (entry.mesh) unmountNode(entry);
      else mountNode(entry);
    }
    if (entry.mesh) entry.mesh.scale.setScalar(entry.visual.radius);
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    if (entry.anchorId !== entry.node.anchorId) retargetSpider(entry, lastFrameTime);
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
      tween: null,
      placedFrame: -1,
      mesh: null,
      ring: null,
      label: null,
    };
    if (!visual.hidden) mountNode(entry);
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    return entry;
  }

  // ---- connectors ----------------------------------------------------------------------------
  const tmpColor = new THREE.Color();
  const tmpMix = new THREE.Color();
  const tmpDir = new THREE.Vector3();
  const coneUp = new THREE.Vector3(0, 1, 0);

  function refreshCone(entry: ConnectorEntry): void {
    if (!entry.visual.directed || !entry.drawn) {
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

  /** Returns true when the connector changed batch (solid ↔ dashed), which needs a buffer rebuild. */
  function restyleConnector(entry: ConnectorEntry): boolean {
    const previous = entry.visual;
    entry.visual = resolver.connectorVisual(entry.connector);
    entry.revision = entry.connector.revision;
    refreshCone(entry);
    return previous.dashed !== entry.visual.dashed;
  }

  /** Hidden endpoints hide a connector entirely; shown web↔web links are simulated as well as drawn. */
  function classifyConnector(entry: ConnectorEntry): void {
    const source = entries.get(entry.connector.source);
    const target = entries.get(entry.connector.target);
    const shown = source !== undefined && target !== undefined && source.mesh !== null && target.mesh !== null;
    const web = shown && source.node.layer === "web" && target.node.layer === "web";
    entry.simulated = web;
    entry.drawn = shown && (web || entry.connector.kind !== "contains");
    refreshCone(entry);
  }

  function createConnectorEntry(connector: Connector, source: NodeEntry, target: NodeEntry): ConnectorEntry {
    const entry: ConnectorEntry = {
      connector,
      link: { id: connector.id, kind: connector.kind, distance: connector.distance, source: source.sim, target: target.sim },
      simulated: false,
      drawn: false,
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

  function rebuildLineBuffers(): void {
    solid.entries = [];
    dashed.entries = [];
    for (const e of connectorEntries.values()) if (e.drawn) (e.visual.dashed ? dashed : solid).entries.push(e);
    for (const batch of [solid, dashed]) {
      batch.positions = new Float32Array(batch.entries.length * 6);
      batch.colors = new Float32Array(batch.entries.length * 6);
      batch.geometry.setAttribute("position", new THREE.BufferAttribute(batch.positions, 3).setUsage(THREE.DynamicDrawUsage));
      batch.geometry.setAttribute("color", new THREE.BufferAttribute(batch.colors, 3));
      batch.object.visible = batch.entries.length > 0;
    }
    refreshLineColors();
  }

  function refreshLineColors(): void {
    for (const batch of [solid, dashed]) {
      const { entries: list, colors } = batch;
      for (let i = 0; i < list.length; i++) {
        const { link, visual } = list[i];
        const direct = selectedId !== null && (link.source.id === selectedId || link.target.id === selectedId);
        let opacity = visual.opacity;
        tmpColor.copy(colorFor(visual.color));
        if (direct) {
          tmpColor.lerp(foreground, 0.35);
          opacity = 1;
        }
        tmpMix.copy(surface).lerp(tmpColor, opacity);
        const o = i * 6;
        colors[o] = colors[o + 3] = tmpMix.r;
        colors[o + 1] = colors[o + 4] = tmpMix.g;
        colors[o + 2] = colors[o + 5] = tmpMix.b;
      }
      const attr = batch.geometry.getAttribute("color");
      if (attr) attr.needsUpdate = true;
    }
  }

  function updateLinePositions(): void {
    for (const batch of [solid, dashed]) {
      const { entries: list, positions } = batch;
      if (list.length === 0) continue;
      for (let i = 0; i < list.length; i++) {
        const { source, target } = list[i].link;
        const o = i * 6;
        positions[o] = source.x ?? 0;
        positions[o + 1] = source.y ?? 0;
        positions[o + 2] = source.z ?? 0;
        positions[o + 3] = target.x ?? 0;
        positions[o + 4] = target.y ?? 0;
        positions[o + 5] = target.z ?? 0;
      }
      const attr = batch.geometry.getAttribute("position");
      if (attr) attr.needsUpdate = true;
    }
    if (dashed.entries.length > 0) dashed.object.computeLineDistances();
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
    meshes = [];
    for (const e of entries.values()) if (e.mesh) meshes.push(e.mesh);
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
        if (entry.simulated) structural = true;
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
      if (entry.simulated) structural = true;
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
  }

  // ---- picking -------------------------------------------------------------------------------
  const listeners = new Set<(event: GraphEvent) => void>();
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let pointerDown: { x: number; y: number } | null = null;

  function emit(event: GraphEvent): void {
    for (const listener of listeners) listener(event);
  }

  function pick(event: PointerEventLike): string | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    pointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
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
    refreshLineColors();
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
      camera.near = Math.max(0.1, distance / 100);
      camera.far = distance + radius * 4;
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
    frame++;
    lastFrameTime = time;
    let ticked = false;
    if (simulation.alpha() >= ALPHA_MIN) {
      simulation.tick();
      ticked = true;
    } else if (fitPending) {
      fitPending = false;
      fit();
    }
    // Spiders ride on the web: place them after the tick, before anything reads positions.
    spiderMoved = false;
    for (const entry of entries.values()) if (entry.node.layer === "spider") placeSpider(entry, time);
    if (clusterStyle.show && (ticked || spiderMoved || hullsDirty)) {
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
      const label = entry.label;
      if (label?.sprite.visible) {
        label.sprite.position.set(x, y, z);
        // Silhouette from the base radius (not the pulse) at this node's own depth, so 3D labels hug near and far nodes alike.
        const nodePxPerUnit = perspective
          ? unitPx / Math.max(-labelTmp.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z, 1e-3)
          : unitPx;
        labelLayout.fontPx = sim.lod.fontPx;
        labelLayout.anchor = visual.labelAnchor;
        labelLayout.clearancePx = visual.radius * nodePxPerUnit + labelSettings.offsetPx;
        label.layout(labelLayout);
      }
    }
    updateLinePositions();
    updateCones();
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
      const previousPadding = clusterStyle.padding;
      clusterStyle = resolver.clusterVisual();
      labelSettings = resolver.labels();
      // `restyleNode` → `refreshLabel` hands this to every label, which re-bakes only if it differs.
      labelStyle = { color: labelCss(), bakeFontSizePx: labelSettings.maxFontSizePx };
      let resimulate = previousPadding !== clusterStyle.padding;
      let drawablesChanged = false;
      let batchesChanged = false;
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
      for (const entry of connectorEntries.values()) {
        if (restyleConnector(entry)) batchesChanged = true;
      }
      if (resimulate) {
        syncSimulation();
        simulation.alpha(Math.max(simulation.alpha(), 0.3));
      } else if (drawablesChanged) {
        refreshDrawables();
      } else if (batchesChanged) {
        rebuildLineBuffers();
      } else {
        refreshLineColors();
      }
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
      entries.clear();
      connectorEntries.clear();
      sphereGeometry.dispose();
      ringGeometry.dispose();
      coneGeometry.dispose();
      solid.geometry.dispose();
      dashed.geometry.dispose();
      solidMaterial.dispose();
      dashedMaterial.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  // Non-contract debug hook: overlapping cluster pairs under the current mode's measure (0 once contained).
  return Object.assign(handle, { __debug: { clusterOverlaps } });
}
