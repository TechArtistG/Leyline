import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import type { GraphEvent, GraphHandle, GraphMode } from "../../shared/graph";
import type { Connector } from "../../shared/model/connector";
import type { Graph, GraphChange } from "../../shared/model/graph";
import type { GraphNode } from "../../shared/model/node";
import { type GraphStyle, StyleResolver } from "../../shared/model/style";
import type { ColorRef, ColorRole, ConnectorVisual, NodeVisual } from "../../shared/model/visual";
import { type ConnectorKind, TREE_CONNECTOR_KINDS } from "../../shared/model/wire";
import { type Label, createLabel } from "./labels";

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
  mesh: Three.Mesh<Three.SphereGeometry, Three.MeshStandardMaterial>;
  ring: Three.Mesh<Three.TorusGeometry, Three.MeshBasicMaterial> | null;
  label: Label | null;
  labelText: string;
}
interface ConnectorEntry {
  connector: Connector;
  link: SimLink;
  /** Both endpoints are web nodes → the link is a simulation force; otherwise only drawn. */
  simulated: boolean;
  /** `contains` into a spider is not drawn: the spider already sits on its anchor. */
  drawn: boolean;
  visual: ConnectorVisual;
  revision: number;
  /** Arrowhead at the target when `visual.directed`. */
  cone: Three.Mesh<Three.ConeGeometry, Three.MeshBasicMaterial> | null;
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
const CHARGE_STRENGTH = -30;
const CHARGE_DISTANCE_MAX = 60;
const COLLIDE_PADDING = 0.6;
/** `2d-lr`: x per containment depth; links only pull y, weak gravity keeps columns compact. */
const LR_COLUMN_SPACING = 12;
const LR_ROW_SPACING = 3;
const LR_LINK_DISTANCE = 4;
const LR_LINK_STRENGTH = 0.3;
const LR_CHARGE_STRENGTH = -10;
const LR_Y_STRENGTH = 0.05;
const TREE_KINDS: ReadonlySet<ConnectorKind> = new Set(TREE_CONNECTOR_KINDS);
const ALPHA_MIN = 0.001;
/** Ticks until the simulation settles (`alpha < ALPHA_MIN`); one tick per frame → ~3 s at 60 Hz. */
const SETTLE_TICKS = 180;
/** Spread of the initial z offset handed to nodes when entering 3D from a flat layout. */
const Z_SPREAD = 4;
/** Distance from the anchor (group node or connected node) at which a new node starts. */
const SPAWN_RADIUS = 3;
const LABEL_WORLD_HEIGHT = 1.1;
const LABEL_GAP = 0.15;
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
    return `#${colorFor(resolver.labelColor()).getHexString()}`;
  }

  // ---- renderer / scene ----------------------------------------------------------------------
  let width = Math.max(1, host.clientWidth);
  let height = Math.max(1, host.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const canvas = renderer.domElement as unknown as CanvasElement;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  canvas.style.display = "block";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 7);
  scene.add(key);

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
  const gravityY = d3.forceY<SimNode>(0).strength(LR_Y_STRENGTH);
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

  function configureForces(): void {
    if (mode === "2d-lr") {
      linkForce.distance(LR_LINK_DISTANCE).strength(LR_LINK_STRENGTH);
      chargeForce.strength(LR_CHARGE_STRENGTH);
      simulation.force("center", null).force("y", gravityY);
    } else {
      linkForce.distance((l) => l.distance * DISTANCE_SCALE).strength(defaultLinkStrength);
      chargeForce.strength(CHARGE_STRENGTH);
      simulation.force("center", centerForce).force("y", null);
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
   * `2d-lr` pins x per column and seeds y by index within the column; hub modes release x.
   */
  function prepareLayout(): void {
    if (mode !== "2d-lr") {
      for (const n of nodeList) n.fx = null;
      return;
    }
    const depth = treeDepths();
    let columns = 0;
    for (const d of depth.values()) if (d + 1 > columns) columns = d + 1;
    const rows: number[] = new Array<number>(columns).fill(0);
    for (const n of nodeList) rows[depth.get(n) ?? 0]++;
    const placed: number[] = new Array<number>(columns).fill(0);
    for (const n of nodeList) {
      const column = depth.get(n) ?? 0;
      n.fx = (column - (columns - 1) / 2) * LR_COLUMN_SPACING;
      if (n.y === undefined || Number.isNaN(n.y)) {
        n.y = (placed[column] - (rows[column] - 1) / 2) * LR_ROW_SPACING;
        n.vy = 0;
      }
      placed[column]++;
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
      if (e.node.layer === "web") nodeList.push(e.sim);
      meshes.push(e.mesh);
    }
    linkList = [];
    for (const e of connectorEntries.values()) if (e.simulated) linkList.push(e.link);
    rebuildAnchorIndex();
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

  function rebuildAnchorIndex(): void {
    anchoredBy.clear();
    for (const e of entries.values()) {
      if (e.anchorId === undefined) continue;
      let list = anchoredBy.get(e.anchorId);
      if (!list) anchoredBy.set(e.anchorId, (list = []));
      list.push(e.node.id);
    }
    for (const list of anchoredBy.values()) list.sort();
  }

  function spiderVisible(entry: NodeEntry, visible: boolean): void {
    entry.mesh.visible = visible;
    if (entry.ring) entry.ring.visible = visible;
    if (entry.label) entry.label.sprite.visible = visible && labelVisible(entry);
  }

  /**
   * Compute a spider's position for this frame: its ring slot around the anchor (anchor chains
   * resolve recursively, once per frame), blended from the previous anchor while a tween runs.
   */
  function placeSpider(entry: NodeEntry, time: number): void {
    if (entry.placedFrame === frame) return;
    entry.placedFrame = frame;
    const anchor = entry.anchorId !== undefined ? entries.get(entry.anchorId) : undefined;
    if (!anchor) {
      spiderVisible(entry, false);
      return;
    }
    if (anchor.node.layer === "spider") placeSpider(anchor, time);
    if (!anchor.mesh.visible) {
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
    entry.sim.x = x;
    entry.sim.y = y;
    entry.sim.z = z;
  }

  /** Spider anchor moved in the model: remember where it is now and slide to the new slot. */
  function retargetSpider(entry: NodeEntry, now: number): void {
    if (entry.sim.x !== undefined && entry.mesh.visible) {
      entry.tween = { from: { x: entry.sim.x, y: entry.sim.y ?? 0, z: entry.sim.z ?? 0 }, start: now };
    }
    entry.anchorId = entry.node.anchorId;
    rebuildAnchorIndex();
  }

  // ---- node visuals --------------------------------------------------------------------------
  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  function labelVisible(entry: NodeEntry): boolean {
    const id = entry.node.id;
    return entry.visual.labelAlways || id === selectedId || id === hoveredId;
  }

  function refreshLabel(entry: NodeEntry): void {
    if (!labelVisible(entry)) {
      if (entry.label) entry.label.sprite.visible = false;
      return;
    }
    if (!entry.label) {
      entry.label = createLabel(THREE, entry.node.label, {
        color: labelCss(),
        fontSizePx: resolver.labelFontSizePx(),
        worldHeight: LABEL_WORLD_HEIGHT,
      });
      entry.labelText = entry.node.label;
      scene.add(entry.label.sprite);
    } else if (entry.labelText !== entry.node.label) {
      entry.label.setText(entry.node.label);
      entry.labelText = entry.node.label;
    }
    entry.label.sprite.visible = true;
  }

  function refreshMaterial(entry: NodeEntry): void {
    const { node, mesh, visual } = entry;
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
    if (ref === undefined) {
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

  /** Re-resolve a node's visual and apply every dependent piece (scale, material, ring, label). */
  function restyleNode(entry: NodeEntry): void {
    entry.visual = resolver.nodeVisual(entry.node);
    entry.revision = entry.node.revision;
    entry.sim.radius = entry.visual.radius;
    entry.mesh.scale.setScalar(entry.visual.radius);
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    if (entry.anchorId !== entry.node.anchorId) retargetSpider(entry, lastFrameTime);
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
    const sim: SimNode = { id: node.id, radius: visual.radius };
    // Web nodes start near an anchor so they do not fly in from the origin. Without one, leave the
    // position undefined and let d3's deterministic phyllotaxis placement handle it. Spiders are
    // placed from their anchor every frame.
    const anchor = node.layer === "web" ? anchorFor(node) : null;
    if (anchor) {
      const angle = rng() * Math.PI * 2;
      const r = SPAWN_RADIUS * (0.5 + rng() * 0.5);
      sim.x = anchor.x + Math.cos(angle) * r;
      sim.y = anchor.y + Math.sin(angle) * r;
      sim.z = mode === "3d-hub" ? anchor.z + (rng() - 0.5) * r : 0;
    }
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
    const mesh = new THREE.Mesh(sphereGeometry, material);
    mesh.scale.setScalar(visual.radius);
    mesh.userData.id = node.id;
    scene.add(mesh);
    const entry: NodeEntry = {
      node,
      sim,
      visual,
      revision: node.revision,
      anchorId: node.anchorId,
      tween: null,
      placedFrame: -1,
      mesh,
      ring: null,
      label: null,
      labelText: "",
    };
    refreshMaterial(entry);
    refreshRing(entry);
    refreshLabel(entry);
    return entry;
  }

  function disposeEntry(entry: NodeEntry): void {
    scene.remove(entry.mesh);
    entry.mesh.material.dispose();
    if (entry.ring) {
      scene.remove(entry.ring);
      entry.ring.material.dispose();
    }
    entry.label?.dispose();
  }

  // ---- connectors ----------------------------------------------------------------------------
  const tmpColor = new THREE.Color();
  const tmpMix = new THREE.Color();
  const tmpDir = new THREE.Vector3();
  const coneUp = new THREE.Vector3(0, 1, 0);

  function refreshCone(entry: ConnectorEntry): void {
    if (!entry.visual.directed) {
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

  function createConnectorEntry(connector: Connector, source: NodeEntry, target: NodeEntry): ConnectorEntry {
    const visual = resolver.connectorVisual(connector);
    const web = source.node.layer === "web" && target.node.layer === "web";
    const entry: ConnectorEntry = {
      connector,
      link: { id: connector.id, kind: connector.kind, distance: connector.distance, source: source.sim, target: target.sim },
      simulated: web,
      drawn: web || connector.kind !== "contains",
      visual,
      revision: connector.revision,
      cone: null,
    };
    refreshCone(entry);
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
    for (const e of entries.values()) meshes.push(e.mesh);
    rebuildAnchorIndex();
    rebuildLineBuffers();
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
          disposeEntry(entry);
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
          if (existing.revision !== node.revision) restyleNode(existing);
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
    const placed: SimNode[] = [];
    for (const e of entries.values()) {
      if (!e.mesh.visible || e.sim.x === undefined) continue;
      placed.push(e.sim);
      const x = e.sim.x;
      const y = e.sim.y ?? 0;
      const z = e.sim.z ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (placed.length === 0) return;
    fitCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let radius = 1;
    for (const n of placed) {
      const dx = (n.x ?? 0) - fitCenter.x;
      const dy = (n.y ?? 0) - fitCenter.y;
      const dz = (n.z ?? 0) - fitCenter.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + n.radius + LABEL_WORLD_HEIGHT;
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
    if (simulation.alpha() >= ALPHA_MIN) {
      simulation.tick();
    } else if (fitPending) {
      fitPending = false;
      fit();
    }
    // Spiders ride on the web: place them after the tick, before anything reads positions.
    for (const entry of entries.values()) if (entry.node.layer === "spider") placeSpider(entry, time);
    const pulse = 1.06 + 0.06 * Math.sin((time / PULSE_PERIOD_MS) * Math.PI * 2);
    for (const entry of entries.values()) {
      if (!entry.mesh.visible) continue;
      const { sim, mesh, visual } = entry;
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
      if (entry.label?.sprite.visible) entry.label.sprite.position.set(x, y + scale + LABEL_GAP, z);
    }
    updateLinePositions();
    updateCones();
    controls.update();
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
  return {
    info,
    graph,

    setStyle(style: GraphStyle) {
      resolver = new StyleResolver(style);
      colorCache = new Map();
      let radiiChanged = false;
      let batchesChanged = false;
      for (const entry of entries.values()) {
        const previousRadius = entry.visual.radius;
        // Labels bake font and colour into their texture; drop them so the next refresh re-renders.
        if (entry.label) {
          entry.label.dispose();
          entry.label = null;
        }
        restyleNode(entry);
        if (entry.node.layer === "web" && previousRadius !== entry.visual.radius) radiiChanged = true;
      }
      for (const entry of connectorEntries.values()) {
        if (restyleConnector(entry)) batchesChanged = true;
      }
      if (radiiChanged) {
        // Collision radii feed the simulation; let it settle again with the new sizes.
        syncSimulation();
        simulation.alpha(Math.max(simulation.alpha(), 0.3));
      } else if (batchesChanged) {
        rebuildLineBuffers();
      } else {
        refreshLineColors();
      }
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
      for (const entry of entries.values()) disposeEntry(entry);
      for (const entry of connectorEntries.values()) disposeConnectorEntry(entry);
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
}
