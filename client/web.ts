import type { PluginTheme } from "@getpaseo/plugin";
import type * as Three from "three";
import type * as OrbitControlsModule from "three/addons/controls/OrbitControls.js";
import { Platform } from "react-native";

// Typechecks without the DOM lib: declare only what this module touches.
declare const window: { devicePixelRatio: number };
declare class ResizeObserver {
  constructor(cb: (entries: ReadonlyArray<{ contentRect: { width: number; height: number } }>) => void);
  observe(el: unknown): void;
  disconnect(): void;
}
interface HostElement {
  clientWidth: number;
  clientHeight: number;
  appendChild(child: unknown): void;
}
interface CanvasElement {
  style: { display: string };
  remove(): void;
}
interface GlContext {
  VERSION: number;
  getParameter(name: number): unknown;
}

export interface SceneHandle {
  /** Human-readable summary of what was initialised (WebGL version, three revision). */
  readonly info: string;
  destroy(): void;
}

/**
 * Spike: mount a three.js scene into a DOM node that React Native Web created for a `<View ref>`.
 * All three.js code lives here so native never evaluates it. Dynamic `import()` rather than
 * `require()`: three's CJS entry is a deprecated shim that calls `process.emitWarning`, which
 * Paseo's client bundle does not provide.
 */
export async function mountScene(parent: unknown, theme: PluginTheme): Promise<SceneHandle | null> {
  if (Platform.OS !== "web" || !parent) return null;
  const THREE: typeof Three = await import("three");
  // Exercises three's `./addons/*` subpath export under Paseo's bundler.
  const { OrbitControls }: typeof OrbitControlsModule = await import("three/addons/controls/OrbitControls.js");

  const host = parent as HostElement;
  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const canvas = renderer.domElement as unknown as CanvasElement;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  canvas.style.display = "block";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
  camera.position.set(0, 6, 18);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const accent = new THREE.Color(theme.colors.accent);
  const muted = new THREE.Color(theme.colors.foregroundMuted);

  // A tiny fixed "graph": a hub node with satellites, joined by lines.
  const group = new THREE.Group();
  const nodeGeo = new THREE.SphereGeometry(0.5, 24, 16);
  const hub = new THREE.Mesh(nodeGeo, new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 }));
  group.add(hub);
  const satelliteMat = new THREE.MeshStandardMaterial({ color: muted });
  const lineMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.6 });
  const count = 8;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = 5;
    const p = new THREE.Vector3(Math.cos(a) * r, Math.sin(a * 2) * 1.5, Math.sin(a) * r);
    const m = new THREE.Mesh(nodeGeo, satelliteMat);
    m.position.copy(p);
    m.scale.setScalar(0.6);
    group.add(m);
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), p]), lineMat));
  }
  scene.add(group);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 7);
  scene.add(key);

  const resize = new ResizeObserver(([entry]) => {
    const w = Math.max(1, entry.contentRect.width);
    const h = Math.max(1, entry.contentRect.height);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);

  renderer.setAnimationLoop(() => {
    group.rotation.y += 0.003;
    controls.update();
    renderer.render(scene, camera);
  });

  const gl = renderer.getContext() as unknown as GlContext;
  const glVersion = String(gl.getParameter(gl.VERSION));
  const info = `three r${THREE.REVISION}, ${glVersion}, ${width}x${height} @${window.devicePixelRatio}x`;

  return {
    info,
    destroy() {
      renderer.setAnimationLoop(null);
      resize.disconnect();
      controls.dispose();
      nodeGeo.dispose();
      satelliteMat.dispose();
      lineMat.dispose();
      hub.material.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
