import type { PluginSvgIcon } from "@getpaseo/plugin/client";

/**
 * The directed "L": three nodes joined by an outer L and an inner, offset L.
 * Monochrome, 24-unit grid, stroke follows the surface colour (Lucide conventions).
 * Line ends are pulled back to the node rings so the rings stay hollow.
 */
export const LEYLINE_ICON: PluginSvgIcon = {
  svg: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">',
    '<circle cx="5" cy="4" r="1.4"/>',
    '<circle cx="5" cy="20" r="1.4"/>',
    '<circle cx="19" cy="20" r="1.4"/>',
    '<path d="M5 5.4V18.6"/>',
    '<path d="M6.4 20H17.6"/>',
    '<path d="M6.1 4.8 9 7v9h7l2.2 2.9"/>',
    "</svg>",
  ].join(""),
};
