/**
 * Minimal ambient typing for `d3-force-3d` (ESM, ships no types). Only the surface the
 * renderer uses is declared; extend here when more of the API is needed.
 */
declare module "d3-force-3d" {
  export interface SimulationNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLink<N extends SimulationNode> {
    source: N;
    target: N;
    index?: number;
  }

  export type RandomSource = () => number;

  export interface Force<N extends SimulationNode> {
    (alpha: number): void;
    initialize?(nodes: N[], random: RandomSource, numDimensions: number): void;
  }

  export interface ForceLink<N extends SimulationNode, L extends SimulationLink<N>> extends Force<N> {
    links(): L[];
    links(links: L[]): this;
    id(): (node: N, i: number, nodes: N[]) => string | number;
    id(id: (node: N, i: number, nodes: N[]) => string | number): this;
    distance(): (link: L, i: number, links: L[]) => number;
    distance(distance: number | ((link: L, i: number, links: L[]) => number)): this;
    strength(): (link: L, i: number, links: L[]) => number;
    strength(strength: number | ((link: L, i: number, links: L[]) => number)): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export interface ForceManyBody<N extends SimulationNode> extends Force<N> {
    strength(): (node: N, i: number, nodes: N[]) => number;
    strength(strength: number | ((node: N, i: number, nodes: N[]) => number)): this;
    distanceMin(): number;
    distanceMin(distance: number): this;
    distanceMax(): number;
    distanceMax(distance: number): this;
    theta(): number;
    theta(theta: number): this;
  }

  export interface ForceCenter<N extends SimulationNode> extends Force<N> {
    x(): number;
    x(x: number): this;
    y(): number;
    y(y: number): this;
    z(): number;
    z(z: number): this;
    strength(): number;
    strength(strength: number): this;
  }

  export interface ForceCollide<N extends SimulationNode> extends Force<N> {
    radius(): (node: N, i: number, nodes: N[]) => number;
    radius(radius: number | ((node: N, i: number, nodes: N[]) => number)): this;
    strength(): number;
    strength(strength: number): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export interface ForceAxis<N extends SimulationNode> extends Force<N> {
    strength(): (node: N, i: number, nodes: N[]) => number;
    strength(strength: number | ((node: N, i: number, nodes: N[]) => number)): this;
  }
  export interface ForceX<N extends SimulationNode> extends ForceAxis<N> {
    x(): (node: N, i: number, nodes: N[]) => number;
    x(x: number | ((node: N, i: number, nodes: N[]) => number)): this;
  }
  export interface ForceY<N extends SimulationNode> extends ForceAxis<N> {
    y(): (node: N, i: number, nodes: N[]) => number;
    y(y: number | ((node: N, i: number, nodes: N[]) => number)): this;
  }
  export interface ForceZ<N extends SimulationNode> extends ForceAxis<N> {
    z(): (node: N, i: number, nodes: N[]) => number;
    z(z: number | ((node: N, i: number, nodes: N[]) => number)): this;
  }

  export interface Simulation<N extends SimulationNode> {
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    numDimensions(): number;
    numDimensions(dimensions: 1 | 2 | 3): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    randomSource(): RandomSource;
    randomSource(source: RandomSource): this;
    force(name: string): Force<N> | undefined;
    force(name: string, force: Force<N> | null): this;
    on(type: "tick" | "end", listener: ((this: Simulation<N>) => void) | null): this;
  }

  export function forceSimulation<N extends SimulationNode>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;
  export function forceLink<N extends SimulationNode, L extends SimulationLink<N>>(links?: L[]): ForceLink<N, L>;
  export function forceManyBody<N extends SimulationNode>(): ForceManyBody<N>;
  export function forceCenter<N extends SimulationNode>(x?: number, y?: number, z?: number): ForceCenter<N>;
  export function forceCollide<N extends SimulationNode>(
    radius?: number | ((node: N, i: number, nodes: N[]) => number),
  ): ForceCollide<N>;
  export function forceX<N extends SimulationNode>(x?: number | ((node: N, i: number, nodes: N[]) => number)): ForceX<N>;
  export function forceY<N extends SimulationNode>(y?: number | ((node: N, i: number, nodes: N[]) => number)): ForceY<N>;
  export function forceZ<N extends SimulationNode>(z?: number | ((node: N, i: number, nodes: N[]) => number)): ForceZ<N>;
}
