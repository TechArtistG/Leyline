import type * as Three from "three";
import type { LabelAnchor } from "../../shared/model/style";

// Typechecks without the DOM lib: declare only what this module touches.
declare const document: { createElement(tag: "canvas"): LabelCanvas };
declare const window: { devicePixelRatio: number };

interface LabelCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): LabelContext | null;
}
interface LabelContext {
  font: string;
  textBaseline: string;
  textAlign: string;
  fillStyle: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
}

/** What gets baked into the texture. Changing any field re-renders the canvas. */
export interface LabelStyle {
  /** CSS colour for the text. */
  color: string;
  /** Font size the canvas is rendered at; the sprite scales it down to the frame's size, so use the largest it will show at. */
  bakeFontSizePx: number;
}

/** Per-frame screen-space placement; nothing here touches the texture. */
export interface LabelLayout {
  /** Font size to show this frame, in CSS px. */
  fontPx: number;
  /** Sprite scale per CSS px: `2 / (viewportHeightPx * projectionMatrix[1][1])` for a non-attenuated sprite. */
  scalePerPx: number;
  anchor: LabelAnchor;
  /** Gap between the node's world position and the sprite's near edge, in px (silhouette radius + offset). */
  clearancePx: number;
}

export interface Label {
  readonly sprite: Three.Sprite;
  setText(text: string): void;
  /** Re-bakes only when colour or bake size actually changed. */
  setStyle(style: LabelStyle): void;
  layout(layout: LabelLayout): void;
  dispose(): void;
}

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Canvas height as a multiple of the font size: room for ascenders and descenders. */
const LINE_HEIGHT = 1.25;
/** Horizontal padding per side as a multiple of the font size, so italic/overhanging glyphs are not clipped. */
const SIDE_PADDING = 0.15;
/** Above every node mesh (0) and ring so a label is never hidden by its own node. */
const LABEL_RENDER_ORDER = 10;

/**
 * Text label rendered into a canvas texture on a screen-space `Sprite` (`sizeAttenuation: false`,
 * no depth test). The texture is baked once per text/style at `bakeFontSizePx × devicePixelRatio`;
 * `layout` sets the sprite's scale (px → NDC) and `center` so the label sits `clearancePx` outside
 * the node on the anchored side, without touching the texture.
 */
export function createLabel(THREE: typeof Three, text: string, style: LabelStyle): Label {
  const canvas = document.createElement("canvas");
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("2D canvas context unavailable for labels");
  const ctx = maybeCtx;
  const texture = new THREE.CanvasTexture<LabelCanvas>(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = LABEL_RENDER_ORDER;

  let current = text;
  let color = style.color;
  let bakeFontSizePx = style.bakeFontSizePx;
  /** Canvas width / height; fixed by the text and font until the next bake. */
  let aspect = 1;

  function bake(): void {
    const dpr = Math.max(1, window.devicePixelRatio);
    const font = `${bakeFontSizePx}px ${FONT_FAMILY}`;
    ctx.font = font;
    const heightPx = Math.ceil(bakeFontSizePx * LINE_HEIGHT);
    const widthPx = Math.max(1, Math.ceil(ctx.measureText(current).width + bakeFontSizePx * SIDE_PADDING * 2));
    canvas.width = Math.ceil(widthPx * dpr);
    canvas.height = Math.ceil(heightPx * dpr);
    // Resizing the canvas resets its state; set everything again.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.fillText(current, widthPx / 2, heightPx / 2);
    texture.needsUpdate = true;
    aspect = widthPx / heightPx;
  }

  bake();

  return {
    sprite,
    setText(value) {
      if (value === current) return;
      current = value;
      bake();
    },
    setStyle(next) {
      if (next.color === color && next.bakeFontSizePx === bakeFontSizePx) return;
      color = next.color;
      bakeFontSizePx = next.bakeFontSizePx;
      bake();
    },
    layout({ fontPx, scalePerPx, anchor, clearancePx }) {
      const heightPx = fontPx * LINE_HEIGHT;
      const widthPx = heightPx * aspect;
      sprite.scale.set(widthPx * scalePerPx, heightPx * scalePerPx, 1);
      // `center` is the sprite-local point placed at `position`, in sprite-size units; values
      // outside [0, 1] push the whole sprite away from the node.
      switch (anchor) {
        case "above":
          sprite.center.set(0.5, -clearancePx / heightPx);
          break;
        case "below":
          sprite.center.set(0.5, 1 + clearancePx / heightPx);
          break;
        case "left":
          sprite.center.set(1 + clearancePx / widthPx, 0.5);
          break;
        case "right":
          sprite.center.set(-clearancePx / widthPx, 0.5);
          break;
      }
    },
    dispose() {
      sprite.removeFromParent();
      texture.dispose();
      material.dispose();
    },
  };
}
