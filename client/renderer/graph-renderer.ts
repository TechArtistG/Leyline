import type { PluginTheme } from "@getpaseo/plugin";
import type * as D3 from "d3-force-3d";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import type { GLink, GNode, GraphEvent, GraphHandle, GraphMode, GraphPatch, LinkKind, NodeKind } from "../../shared/graph";
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

interface SimNode extends D3.SimulationNode {
  id: string;
  kind: NodeKind;
  label: string;
  group?: string;
  state?: GNode["state"];
  /** Sphere radius in world units; drives collision and charge. */
  radius: number;
}
interface SimLink extends D3.SimulationLink<SimNode> {
  id: string;
  kind: LinkKind;
}
interface NodeEntry {
  node: SimNode;
  mesh: Three.Mesh<Three.SphereGeometry, Three.MeshStandardMaterial>;
  label: Label | null;
}
interface Point {
  x: number;
  y: number;
  z: number;
}

const SEED = 0x1e71;
const KIND_RADIUS: Record<NodeKind, number> = {
  host: 1.6,
  repo: 1.3,
  branch: 0.7,
  worktree: 1.0,
  agent: 0.9,
  subagent: 0.6,
  file: 0.4,
  pr: 0.8,
};
const LINK_DISTANCE: Record<LinkKind, number> = {
  contains: 6,
  "branch-of": 5,
  spawned: 4,
  "merges-into": 8,
  "shares-context": 10,
  touches: 3,
};
/** World units per `LINK_DISTANCE` unit; spheres are 0.4–1.6 units, so links of 6–20 read as a graph, not a blob. */
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
const TREE_LINK: Partial<Record<LinkKind, true>> = { contains: true, spawned: true, "branch-of": true, touches: true };
const ALPHA_MIN = 0.001;
/** Ticks until the simulation settles (`alpha < ALPHA_MIN`); one tick per frame → ~3 s at 60 Hz. */
const SETTLE_TICKS = 180;
/** Spread of the initial z offset handed to nodes when entering 3D from a flat layout. */
const Z_SPREAD = 4;
/** Distance from the anchor (group node or linked node) at which a new node starts. */
const SPAWN_RADIUS = 3;
const STRONG_LINK: Partial<Record<LinkKind, true>> = { "merges-into": true, "shares-context": true };
const ALWAYS_LABELED: Partial<Record<NodeKind, true>> = { host: true, repo: true, worktree: true, agent: true };
const LABEL_FONT_PX = 13;
const LABEL_WORLD_HEIGHT = 1.1;
const LABEL_GAP = 0.15;
const FIT_MARGIN = 1.1;
const PULSE_PERIOD_MS = 1600;
const CAMERA_3D_DISTANCE = 60;
const ORTHO_DEPTH = 100;
const ORTHO_INITIAL_ZOOM = 8;
const CLICK_SLOP_PX = 4;

/** Tiny seeded LCG (Numerical Recipes constants); returns floats in [0, 1). */
function lcg(seed: number): D3.RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Build a renderer into `host`. All WebGL/DOM work lives here; `client/web.ts` gates it to web. */
export function createGraphRenderer(host: HostElement, theme: PluginTheme, initialMode: GraphMode, libs: RendererLibs): GraphHandle {
  const { THREE, OrbitControls, d3 } = libs;

  // ---- palette -------------------------------------------------------------------------------
  const colors = theme.colors;
  const accent = new THREE.Color(colors.accent);
  const success = new THREE.Color(colors.statusSuccess);
  const warning = new THREE.Color(colors.statusWarning);
  const danger = new THREE.Color(colors.statusDanger);
  const muted = new THREE.Color(colors.foregroundMuted);
  const foreground = new THREE.Color(colors.foreground);
  const border = new THREE.Color(colors.border);
  const surface = new THREE.Color(colors.surface0);
  const prColor = accent.clone().lerp(success, 0.5);
  const branchColor = muted.clone().lerp(accent, 0.35);
  const LINK_COLOR: Record<LinkKind, Three.Color> = {
    contains: muted,
    "branch-of": muted,
    spawned: muted,
    "merges-into": success,
    "shares-context": accent,
    touches: border,
  };

  function nodeColor(node: SimNode): Three.Color {
    switch (node.kind) {
      case "agent":
      case "subagent":
        switch (node.state) {
          case "executing":
            return success;
          case "thinking":
          case "attention":
            return warning;
          case "error":
            return danger;
          default:
            return accent;
        }
      case "file":
        return foreground;
      case "pr":
        return prColor;
      case "branch":
        return branchColor;
      default:
        return muted;
    }
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
  const lineGeometry = new THREE.BufferGeometry();
  // Opacity per link kind is pre-mixed into the vertex colours against the surface colour, so one
  // opaque draw call carries both strong (0.9) and weak (0.5) links.
  const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  scene.add(lines);
  let linePositions = new Float32Array(0);
  let lineColors = new Float32Array(0);

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
    } else {
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
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
  const links = new Map<string, SimLink>();
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
      linkForce.distance((l) => LINK_DISTANCE[l.kind] * DISTANCE_SCALE).strength(defaultLinkStrength);
      chargeForce.strength(CHARGE_STRENGTH);
      simulation.force("center", centerForce).force("y", null);
    }
  }
  configureForces();

  /** BFS depth over tree links from roots (no incoming tree link); unreachable nodes go one past the deepest column. */
  function treeDepths(): Map<SimNode, number> {
    const children = new Map<SimNode, SimNode[]>();
    const hasParent = new Set<SimNode>();
    for (const l of linkList) {
      if (TREE_LINK[l.kind] !== true) continue;
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

  /** Push the current node/link lists into the simulation and rebuild dependent buffers. */
  function syncSimulation(): void {
    nodeList = [];
    meshes = [];
    for (const e of entries.values()) {
      nodeList.push(e.node);
      meshes.push(e.mesh);
    }
    linkList = [...links.values()];
    prepareLayout();
    simulation.nodes(nodeList);
    enforceDimensions();
    linkForce.links(linkList);
    configureForces();
    rebuildLineBuffers();
  }

  // ---- node visuals --------------------------------------------------------------------------
  let selectedId: string | null = null;
  let hoveredId: string | null = null;

  function labelVisible(entry: NodeEntry): boolean {
    const id = entry.node.id;
    return ALWAYS_LABELED[entry.node.kind] === true || id === selectedId || id === hoveredId;
  }

  function refreshLabel(entry: NodeEntry): void {
    if (!labelVisible(entry)) {
      if (entry.label) entry.label.sprite.visible = false;
      return;
    }
    if (!entry.label) {
      entry.label = createLabel(THREE, entry.node.label, {
        color: colors.foreground,
        fontSizePx: LABEL_FONT_PX,
        worldHeight: LABEL_WORLD_HEIGHT,
      });
      scene.add(entry.label.sprite);
    }
    entry.label.sprite.visible = true;
  }

  function refreshMaterial(entry: NodeEntry): void {
    const { node, mesh } = entry;
    const color = nodeColor(node);
    mesh.material.color.copy(color);
    mesh.material.emissive.copy(color);
    let intensity = node.kind === "agent" || node.kind === "subagent" ? 0.45 : 0.08;
    if (node.id === selectedId) intensity += 0.5;
    if (node.id === hoveredId) intensity += 0.2;
    mesh.material.emissiveIntensity = intensity;
  }

  /** Where a new node should start: its group node, the centroid of its group, or a linked node. */
  function anchorFor(gnode: GNode, patchLinks: readonly GLink[] | undefined): Point | null {
    if (gnode.group) {
      const groupNode = entries.get(gnode.group)?.node;
      if (groupNode && groupNode.x !== undefined) return { x: groupNode.x, y: groupNode.y ?? 0, z: groupNode.z ?? 0 };
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (const e of entries.values()) {
        if (e.node.group !== gnode.group || e.node.x === undefined) continue;
        sx += e.node.x;
        sy += e.node.y ?? 0;
        sz += e.node.z ?? 0;
        count++;
      }
      if (count > 0) return { x: sx / count, y: sy / count, z: sz / count };
    }
    if (patchLinks) {
      for (const l of patchLinks) {
        const otherId = l.source === gnode.id ? l.target : l.target === gnode.id ? l.source : null;
        if (otherId === null) continue;
        const other = entries.get(otherId)?.node;
        if (other && other.x !== undefined) return { x: other.x, y: other.y ?? 0, z: other.z ?? 0 };
      }
    }
    return null;
  }

  function createEntry(gnode: GNode, patchLinks: readonly GLink[] | undefined): NodeEntry {
    const node: SimNode = {
      id: gnode.id,
      kind: gnode.kind,
      label: gnode.label,
      group: gnode.group,
      state: gnode.state,
      radius: KIND_RADIUS[gnode.kind] * (gnode.weight ?? 1),
    };
    // Start near an anchor so the node does not fly in from the origin. Without one, leave the
    // position undefined and let d3's deterministic phyllotaxis placement handle it.
    const anchor = anchorFor(gnode, patchLinks);
    if (anchor) {
      const angle = rng() * Math.PI * 2;
      const r = SPAWN_RADIUS * (0.5 + rng() * 0.5);
      node.x = anchor.x + Math.cos(angle) * r;
      node.y = anchor.y + Math.sin(angle) * r;
      node.z = mode === "3d-hub" ? anchor.z + (rng() - 0.5) * r : 0;
    }
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
    const mesh = new THREE.Mesh(sphereGeometry, material);
    mesh.scale.setScalar(node.radius);
    mesh.userData.id = gnode.id;
    scene.add(mesh);
    const entry: NodeEntry = { node, mesh, label: null };
    refreshMaterial(entry);
    refreshLabel(entry);
    return entry;
  }

  function updateEntry(entry: NodeEntry, gnode: GNode): void {
    const { node } = entry;
    const relabel = node.label !== gnode.label;
    node.kind = gnode.kind;
    node.label = gnode.label;
    node.group = gnode.group;
    node.state = gnode.state;
    node.radius = KIND_RADIUS[gnode.kind] * (gnode.weight ?? 1);
    entry.mesh.scale.setScalar(node.radius);
    refreshMaterial(entry);
    if (relabel && entry.label) entry.label.setText(gnode.label);
    refreshLabel(entry);
  }

  function disposeEntry(entry: NodeEntry): void {
    scene.remove(entry.mesh);
    entry.mesh.material.dispose();
    entry.label?.dispose();
  }

  // ---- links ---------------------------------------------------------------------------------
  const tmpColor = new THREE.Color();
  const tmpMix = new THREE.Color();

  function rebuildLineBuffers(): void {
    linePositions = new Float32Array(linkList.length * 6);
    lineColors = new Float32Array(linkList.length * 6);
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute("color", new THREE.BufferAttribute(lineColors, 3));
    refreshLineColors();
  }

  function refreshLineColors(): void {
    for (let i = 0; i < linkList.length; i++) {
      const link = linkList[i];
      const direct = selectedId !== null && (link.source.id === selectedId || link.target.id === selectedId);
      let opacity = STRONG_LINK[link.kind] === true ? 0.9 : 0.5;
      tmpColor.copy(LINK_COLOR[link.kind]);
      if (direct) {
        tmpColor.lerp(foreground, 0.35);
        opacity = 1;
      }
      tmpMix.copy(surface).lerp(tmpColor, opacity);
      const o = i * 6;
      lineColors[o] = lineColors[o + 3] = tmpMix.r;
      lineColors[o + 1] = lineColors[o + 4] = tmpMix.g;
      lineColors[o + 2] = lineColors[o + 5] = tmpMix.b;
    }
    const attr = lineGeometry.getAttribute("color");
    if (attr) attr.needsUpdate = true;
  }

  function updateLinePositions(): void {
    for (let i = 0; i < linkList.length; i++) {
      const { source, target } = linkList[i];
      const o = i * 6;
      linePositions[o] = source.x ?? 0;
      linePositions[o + 1] = source.y ?? 0;
      linePositions[o + 2] = source.z ?? 0;
      linePositions[o + 3] = target.x ?? 0;
      linePositions[o + 4] = target.y ?? 0;
      linePositions[o + 5] = target.z ?? 0;
    }
    const attr = lineGeometry.getAttribute("position");
    if (attr) attr.needsUpdate = true;
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
    return hits.length > 0 ? (hits[0].object.userData.id as string) : null;
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
    if (nodeList.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const n of nodeList) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const z = n.z ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    fitCenter.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let radius = 1;
    for (const n of nodeList) {
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
    if (simulation.alpha() >= ALPHA_MIN) {
      simulation.tick();
    } else if (fitPending) {
      fitPending = false;
      fit();
    }
    const pulse = 1.06 + 0.06 * Math.sin((time / PULSE_PERIOD_MS) * Math.PI * 2);
    for (const entry of entries.values()) {
      const { node, mesh } = entry;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const z = node.z ?? 0;
      mesh.position.set(x, y, z);
      const scale = node.state === "executing" ? node.radius * pulse : node.radius;
      mesh.scale.setScalar(scale);
      if (entry.label?.sprite.visible) entry.label.sprite.position.set(x, y + scale + LABEL_GAP, z);
    }
    updateLinePositions();
    controls.update();
    renderer.render(scene, camera);
  });

  const gl = renderer.getContext() as unknown as GlContext;
  const glVersion = String(gl.getParameter(gl.VERSION));
  const info = `three r${THREE.REVISION}, ${glVersion}, d3-force-3d, ${width}x${height} @${window.devicePixelRatio}x`;

  // ---- handle --------------------------------------------------------------------------------
  return {
    info,

    apply(patch: GraphPatch) {
      const wasEmpty = entries.size === 0;
      let structural = false;
      let added = false;

      if (patch.removeLinks) {
        for (const id of patch.removeLinks) structural = links.delete(id) || structural;
      }
      if (patch.removeNodes) {
        for (const id of patch.removeNodes) {
          const entry = entries.get(id);
          if (!entry) continue;
          disposeEntry(entry);
          entries.delete(id);
          for (const [linkId, link] of links) {
            if (link.source.id === id || link.target.id === id) links.delete(linkId);
          }
          if (id === selectedId) setSelected(null);
          if (id === hoveredId) setHovered(null);
          structural = true;
        }
      }
      if (patch.upsertNodes) {
        for (const gnode of patch.upsertNodes) {
          const existing = entries.get(gnode.id);
          if (existing) {
            updateEntry(existing, gnode);
          } else {
            entries.set(gnode.id, createEntry(gnode, patch.upsertLinks));
            structural = true;
            added = true;
          }
        }
      }
      if (patch.upsertLinks) {
        for (const glink of patch.upsertLinks) {
          const source = entries.get(glink.source);
          const target = entries.get(glink.target);
          // Links whose endpoints are not (yet) known are dropped; the producer re-sends them with the nodes.
          if (!source || !target) continue;
          const existing = links.get(glink.id);
          if (existing && existing.source === source.node && existing.target === target.node) {
            existing.kind = glink.kind;
            continue;
          }
          links.set(glink.id, { id: glink.id, kind: glink.kind, source: source.node, target: target.node });
          structural = true;
        }
      }

      if (structural) {
        syncSimulation();
        simulation.alpha(Math.max(simulation.alpha(), wasEmpty || added ? 1 : 0.6));
        if (wasEmpty) fitPending = true;
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
      entries.clear();
      links.clear();
      sphereGeometry.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
