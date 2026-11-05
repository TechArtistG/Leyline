import type * as Three from "three";

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

export interface LabelOptions {
  /** CSS colour for the text. */
  color: string;
  fontSizePx: number;
  /** Height of the sprite in world units; width follows the text's aspect ratio. */
  worldHeight: number;
}

export interface Label {
  readonly sprite: Three.Sprite;
  setText(text: string): void;
  dispose(): void;
}

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PADDING_PX = 4;

/**
 * Text label rendered into a canvas texture on a `Sprite`. The sprite is anchored at its
 * bottom-centre (`center = (0.5, 0)`), so positioning it at `(x, top-of-node, z)` floats the
 * text above the node in both camera modes. Size attenuates with distance.
 */
export function createLabel(THREE: typeof Three, text: string, options: LabelOptions): Label {
  const canvas = document.createElement("canvas");
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("2D canvas context unavailable for labels");
  const ctx = maybeCtx;
  const texture = new THREE.CanvasTexture<LabelCanvas>(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, sizeAttenuation: true });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 1;

  const font = `${options.fontSizePx}px ${FONT_FAMILY}`;
  const dpr = Math.max(1, window.devicePixelRatio);
  const heightPx = Math.ceil(options.fontSizePx * 1.4) + PADDING_PX * 2;

  function draw(value: string): void {
    ctx.font = font;
    const widthPx = Math.max(1, Math.ceil(ctx.measureText(value).width) + PADDING_PX * 2);
    canvas.width = Math.ceil(widthPx * dpr);
    canvas.height = Math.ceil(heightPx * dpr);
    // Resizing the canvas resets its state; set everything again.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = options.color;
    ctx.fillText(value, widthPx / 2, heightPx / 2);
    texture.needsUpdate = true;
    sprite.scale.set(options.worldHeight * (widthPx / heightPx), options.worldHeight, 1);
  }

  draw(text);

  return {
    sprite,
    setText(value) {
      draw(value);
    },
    dispose() {
      sprite.removeFromParent();
      texture.dispose();
      material.dispose();
    },
  };
}
