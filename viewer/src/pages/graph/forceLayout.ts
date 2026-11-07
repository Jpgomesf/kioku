// A ForceAtlas2-style force layout, pure and deterministic for a given seed.
//
// Why this model: plain spring layouts pull every note towards the hubs, so hub-heavy areas
// collapse into one hairball. ForceAtlas2 with "dissuade hubs" makes tightly linked groups
// pull together and pushes groups apart, which is what a reader wants to see. Attraction is
// linear, not LinLog: LinLog pushed groups so far apart that each one shrank to an unreadable
// ball once the whole area was fitted to the screen. Repulsion uses a Barnes-Hut quadtree so one step costs O(n log n).
import { seededRandom } from "./layout";

export interface ForceLayoutInput {
  n: number;
  edges: ReadonlyArray<readonly [number, number]>;
  seed: number;
}

export interface ForceLayoutOptions {
  maxIterations?: number;
  onProgress?: (xs: Float64Array, ys: Float64Array) => void;
  /** Start positions for every note instead of the seeded disc (tests use it for edge cases). */
  initial?: { xs: ArrayLike<number>; ys: ArrayLike<number> };
}

/** Enough rounds for about 2,000 notes and 16,000 links to settle in a few seconds. */
export const DEFAULT_MAX_ITERATIONS = 400;
/** How often onProgress is called, in iterations. */
export const PROGRESS_EVERY = 20;

/** Barnes-Hut accuracy: a cell this small relative to its distance counts as one body. */
const THETA = 1.2;
const REPULSION = 2;
/** Weak pull to the centre so separate components stay near each other. */
const GRAVITY = 1;
/** Unlinked notes sit in a band this far out, as a share of the linked notes' outer radius. */
const ORPHAN_BAND = { inner: 1.1, outer: 1.4 } as const;
/** The share of linked notes inside the outer radius, so a few strays don't widen the band. */
const OUTER_PERCENTILE = 0.98;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Below this mean move per note (relative to the spread) the layout counts as settled. */
const SETTLED = 0.0015;
const MIN_ITERATIONS = 40;
/** The most a note may move in one step, as a share of the layout's spread. */
const MAX_STEP = 0.05;
/** Stops the quadtree from splitting forever when notes sit on the same spot. */
const MAX_DEPTH = 32;
const TINY = 1e-9;

/**
 * Lay out n notes. Only notes with at least one link are simulated: an unlinked note feels
 * the repulsion of every other note but only a weak pull back, so it would drift to a far
 * ring and shrink the real graph after fitting. Unlinked notes are instead placed
 * deterministically in a band just outside the linked ones.
 */
export function forceLayout(
  input: ForceLayoutInput,
  options: ForceLayoutOptions = {},
): { xs: Float64Array; ys: Float64Array } {
  const n = Math.max(0, Math.floor(input.n));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  if (n <= 1) return { xs, ys };

  const links = cleanLinks(n, input.edges);
  const local = new Int32Array(n).fill(-1);
  const linked: number[] = [];
  for (const i of links) local[i] = 1; // mark notes with a link, then number them
  for (let i = 0; i < n; i += 1) {
    if (local[i] === 1) {
      local[i] = linked.length;
      linked.push(i);
    }
  }
  const orphans: number[] = [];
  for (let i = 0; i < n; i += 1) if (local[i] === -1) orphans.push(i);
  const subLinks = links.map((i) => local[i] as number);

  const rand = seededRandom(input.seed);
  const turn = rand() * 2 * Math.PI;
  const scatter = (sx: Float64Array, sy: Float64Array) => {
    linked.forEach((i, k) => {
      xs[i] = sx[k] as number;
      ys[i] = sy[k] as number;
    });
    placeOrphans(orphans, linked, xs, ys, turn);
  };

  const m = linked.length;
  const sx = new Float64Array(m);
  const sy = new Float64Array(m);
  // Start on a seeded disc sized so notes are roughly evenly spaced.
  const radius = Math.sqrt(m) * 10;
  linked.forEach((i, k) => {
    const r = radius * Math.sqrt(rand());
    const a = rand() * 2 * Math.PI;
    sx[k] = options.initial ? Number(options.initial.xs[i] ?? 0) : r * Math.cos(a);
    sy[k] = options.initial ? Number(options.initial.ys[i] ?? 0) : r * Math.sin(a);
  });
  if (m > 0) {
    simulate(sx, sy, subLinks, options.maxIterations, (px, py) => {
      if (!options.onProgress) return;
      scatter(px, py);
      options.onProgress(xs, ys);
    });
  }
  scatter(sx, sy);
  return { xs, ys };
}

/**
 * Put unlinked notes on a golden-angle spiral in a band just outside the linked notes'
 * outer radius, evenly by area. With no linked notes they fill a disc instead.
 */
function placeOrphans(
  orphans: number[],
  linked: number[],
  xs: Float64Array,
  ys: Float64Array,
  turn: number,
): void {
  const count = orphans.length;
  if (count === 0) return;
  let cx = 0;
  let cy = 0;
  for (const i of linked) {
    cx += xs[i] as number;
    cy += ys[i] as number;
  }
  if (linked.length > 0) {
    cx /= linked.length;
    cy /= linked.length;
  }
  const radii = linked
    .map((i) => Math.hypot((xs[i] as number) - cx, (ys[i] as number) - cy))
    .sort((p, q) => p - q);
  const outer = radii[Math.min(radii.length - 1, Math.floor(radii.length * OUTER_PERCENTILE))] ?? 0;
  // Keep about 10 units between neighbours even when the linked part is tiny.
  const spacing = 10;
  let inner = ORPHAN_BAND.inner * outer;
  let far = ORPHAN_BAND.outer * outer;
  const needed = (count * spacing * spacing) / Math.PI;
  if (far * far - inner * inner < needed) far = Math.sqrt(inner * inner + needed);
  if (linked.length === 0) inner = 0;
  orphans.forEach((i, k) => {
    const t = (k + 0.5) / count;
    const r = Math.sqrt(inner * inner + t * (far * far - inner * inner));
    const a = turn + k * GOLDEN_ANGLE;
    xs[i] = cx + r * Math.cos(a);
    ys[i] = cy + r * Math.sin(a);
  });
}

/** The ForceAtlas2 loop on linked notes only, moving xs and ys in place. */
function simulate(
  xs: Float64Array,
  ys: Float64Array,
  links: Int32Array,
  iterations: number | undefined,
  onProgress: (xs: Float64Array, ys: Float64Array) => void,
): void {
  const n = xs.length;
  const mass = new Float64Array(n).fill(1);
  for (let e = 0; e < links.length; e += 2) {
    mass[links[e] as number] = (mass[links[e] as number] as number) + 1;
    mass[links[e + 1] as number] = (mass[links[e + 1] as number] as number) + 1;
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const oldFx = new Float64Array(n);
  const oldFy = new Float64Array(n);
  const tree = new QuadTree(n);
  const speed = { value: 1, efficiency: 1 };
  // FA2 "outbound attraction compensation": dividing by the hub's mass weakens every link,
  // so scale attraction back up by the mean mass to keep it balanced against repulsion.
  let meanMass = 0;
  for (let i = 0; i < n; i += 1) meanMass += mass[i] as number;
  meanMass /= n;
  const maxIterations = Math.max(1, iterations ?? DEFAULT_MAX_ITERATIONS);

  for (let step = 0; step < maxIterations; step += 1) {
    oldFx.set(fx);
    oldFy.set(fy);
    fx.fill(0);
    fy.fill(0);

    tree.build(xs, ys, mass);
    for (let i = 0; i < n; i += 1) tree.repel(i, xs, ys, mass, fx, fy);
    attract(links, xs, ys, mass, meanMass, fx, fy);
    gravity(xs, ys, mass, fx, fy);

    const meanMove = move(xs, ys, mass, fx, fy, oldFx, oldFy, speed, spread(xs, ys) * MAX_STEP);
    if ((step + 1) % PROGRESS_EVERY === 0) onProgress(xs, ys);
    if (step >= MIN_ITERATIONS && meanMove < SETTLED * spread(xs, ys)) break;
  }
}

/** Links as a flat array of index pairs: no self links, no duplicates, nothing out of range. */
function cleanLinks(n: number, edges: ReadonlyArray<readonly [number, number]>): Int32Array {
  const seen = new Set<number>();
  for (const [a, b] of edges) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if (a < 0 || b < 0 || a >= n || b >= n) continue;
    seen.add(Math.min(a, b) * n + Math.max(a, b));
  }
  const codes = [...seen].sort((p, q) => p - q);
  const out = new Int32Array(codes.length * 2);
  codes.forEach((code, k) => {
    out[2 * k] = Math.floor(code / n);
    out[2 * k + 1] = code % n;
  });
  return out;
}

/**
 * Linear attraction along links, divided by the hub's mass ("dissuade hubs"). Links are
 * undirected here, so the busier end counts as the source: a hub then pulls each leaf
 * weakly and cannot drag whole clusters into itself.
 */
function attract(
  links: Int32Array,
  xs: Float64Array,
  ys: Float64Array,
  mass: Float64Array,
  compensation: number,
  fx: Float64Array,
  fy: Float64Array,
): void {
  for (let e = 0; e < links.length; e += 2) {
    const a = links[e] as number;
    const b = links[e + 1] as number;
    const dx = (xs[a] as number) - (xs[b] as number);
    const dy = (ys[a] as number) - (ys[b] as number);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < TINY) continue;
    const hub = Math.max(mass[a] as number, mass[b] as number);
    const f = compensation / hub;
    fx[a] = (fx[a] as number) - dx * f;
    fy[a] = (fy[a] as number) - dy * f;
    fx[b] = (fx[b] as number) + dx * f;
    fy[b] = (fy[b] as number) + dy * f;
  }
}

/** FA2 gravity: a constant pull towards the centre, scaled by mass. */
function gravity(
  xs: Float64Array,
  ys: Float64Array,
  mass: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
): void {
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    const d = Math.sqrt(x * x + y * y);
    if (d < TINY) continue;
    const f = (GRAVITY * (mass[i] as number)) / d;
    fx[i] = (fx[i] as number) - x * f;
    fy[i] = (fy[i] as number) - y * f;
  }
}

/**
 * FA2 adaptive speed: a global speed from total swing (forces flipping) versus traction
 * (forces agreeing), and a per-note slow-down for notes that swing. Returns the mean move.
 */
function move(
  xs: Float64Array,
  ys: Float64Array,
  mass: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  oldFx: Float64Array,
  oldFy: Float64Array,
  speed: { value: number; efficiency: number },
  cap: number,
): number {
  const n = xs.length;
  let totalSwing = 0;
  let totalTraction = 0;
  for (let i = 0; i < n; i += 1) {
    const m = mass[i] as number;
    const sx = (fx[i] as number) - (oldFx[i] as number);
    const sy = (fy[i] as number) - (oldFy[i] as number);
    const tx = (fx[i] as number) + (oldFx[i] as number);
    const ty = (fy[i] as number) + (oldFy[i] as number);
    totalSwing += m * Math.sqrt(sx * sx + sy * sy);
    totalTraction += 0.5 * m * Math.sqrt(tx * tx + ty * ty);
  }
  if (totalSwing > TINY && totalTraction > TINY) {
    const estimated = 0.05 * Math.sqrt(n);
    const minJitter = Math.sqrt(estimated);
    let jitter = Math.max(minJitter, Math.min(10, (estimated * totalTraction) / (n * n)));
    if (totalSwing / totalTraction > 2) {
      if (speed.efficiency > 0.05) speed.efficiency *= 0.5;
      jitter = Math.max(jitter, 1);
    }
    const target = (jitter * speed.efficiency * totalTraction) / totalSwing;
    if (totalSwing > jitter * totalTraction) {
      if (speed.efficiency > 0.05) speed.efficiency *= 0.7;
    } else if (speed.value < 1000) {
      speed.efficiency *= 1.3;
    }
    speed.value += Math.min(target - speed.value, 0.5 * speed.value);
    if (!Number.isFinite(speed.value) || speed.value <= 0) speed.value = 1;
  }

  let moved = 0;
  for (let i = 0; i < n; i += 1) {
    const m = mass[i] as number;
    const sx = (fx[i] as number) - (oldFx[i] as number);
    const sy = (fy[i] as number) - (oldFy[i] as number);
    const swing = m * Math.sqrt(sx * sx + sy * sy);
    const factor = speed.value / (1 + Math.sqrt(speed.value * swing));
    let dx = (fx[i] as number) * factor;
    let dy = (fy[i] as number) * factor;
    // A hard cap per step keeps one huge force from flinging a note away.
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > cap) {
      dx = (dx / len) * cap;
      dy = (dy / len) * cap;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    xs[i] = (xs[i] as number) + dx;
    ys[i] = (ys[i] as number) + dy;
    moved += Math.min(len, cap);
  }
  return moved / n;
}

/** Root-mean-square distance from the centroid, at least 1. */
function spread(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i += 1) {
    cx += xs[i] as number;
    cy += ys[i] as number;
  }
  cx /= n;
  cy /= n;
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - cx;
    const dy = (ys[i] as number) - cy;
    s += dx * dx + dy * dy;
  }
  return Math.max(1, Math.sqrt(s / n));
}

const EMPTY = -1;
const INTERNAL = -2;
/** A leaf at MAX_DEPTH holding several notes on (nearly) the same spot. */
const CROWD = -3;

/** A Barnes-Hut quadtree in flat arrays, rebuilt every step. */
class QuadTree {
  private x0: number[] = [];
  private y0: number[] = [];
  private size: number[] = [];
  private mass: number[] = [];
  private sumX: number[] = [];
  private sumY: number[] = [];
  private firstChild: number[] = [];
  private body: number[] = [];
  private depth: number[] = [];
  private count = 0;
  private readonly stack: number[] = [];

  constructor(private readonly n: number) {}

  build(xs: Float64Array, ys: Float64Array, mass: Float64Array): void {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.n; i += 1) {
      minX = Math.min(minX, xs[i] as number);
      minY = Math.min(minY, ys[i] as number);
      maxX = Math.max(maxX, xs[i] as number);
      maxY = Math.max(maxY, ys[i] as number);
    }
    const side = Math.max(maxX - minX, maxY - minY, 1) * 1.01;
    this.count = 0;
    this.addCell(minX - side * 0.005, minY - side * 0.005, side, 0);
    for (let i = 0; i < this.n; i += 1)
      this.insert(i, xs[i] as number, ys[i] as number, mass[i] as number, xs, ys, mass);
  }

  private addCell(x0: number, y0: number, size: number, depth: number): number {
    const c = this.count;
    this.x0[c] = x0;
    this.y0[c] = y0;
    this.size[c] = size;
    this.mass[c] = 0;
    this.sumX[c] = 0;
    this.sumY[c] = 0;
    this.firstChild[c] = -1;
    this.body[c] = EMPTY;
    this.depth[c] = depth;
    this.count += 1;
    return c;
  }

  private quadrant(c: number, x: number, y: number): number {
    const half = (this.size[c] as number) / 2;
    const right = x >= (this.x0[c] as number) + half ? 1 : 0;
    const down = y >= (this.y0[c] as number) + half ? 2 : 0;
    return (this.firstChild[c] as number) + right + down;
  }

  private addMass(c: number, x: number, y: number, m: number): void {
    this.mass[c] = (this.mass[c] as number) + m;
    this.sumX[c] = (this.sumX[c] as number) + x * m;
    this.sumY[c] = (this.sumY[c] as number) + y * m;
  }

  private insert(
    i: number,
    x: number,
    y: number,
    m: number,
    xs: Float64Array,
    ys: Float64Array,
    mass: Float64Array,
  ): void {
    let c = 0;
    for (;;) {
      const kind = this.body[c] as number;
      if (kind === INTERNAL) {
        this.addMass(c, x, y, m);
        c = this.quadrant(c, x, y);
        continue;
      }
      if (kind === EMPTY) {
        this.body[c] = i;
        this.addMass(c, x, y, m);
        return;
      }
      if (kind === CROWD || (this.depth[c] as number) >= MAX_DEPTH) {
        this.body[c] = CROWD;
        this.addMass(c, x, y, m);
        return;
      }
      // A leaf with one note: split it and push that note down one level.
      const j = kind;
      const half = (this.size[c] as number) / 2;
      const d = (this.depth[c] as number) + 1;
      const x0 = this.x0[c] as number;
      const y0 = this.y0[c] as number;
      this.firstChild[c] = this.addCell(x0, y0, half, d);
      this.addCell(x0 + half, y0, half, d);
      this.addCell(x0, y0 + half, half, d);
      this.addCell(x0 + half, y0 + half, half, d);
      this.body[c] = INTERNAL;
      const child = this.quadrant(c, xs[j] as number, ys[j] as number);
      this.body[child] = j;
      this.addMass(child, xs[j] as number, ys[j] as number, mass[j] as number);
      // The cell's own mass already counts j; the loop adds i next.
    }
  }

  /** FA2 repulsion on note i: REPULSION * m_i * m_c / distance, from near notes and far cells. */
  repel(
    i: number,
    xs: Float64Array,
    ys: Float64Array,
    mass: Float64Array,
    fx: Float64Array,
    fy: Float64Array,
  ): void {
    const x = xs[i] as number;
    const y = ys[i] as number;
    const mi = mass[i] as number;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    let ax = 0;
    let ay = 0;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const mc = this.mass[c] as number;
      const kind = this.body[c] as number;
      if (mc <= 0 || kind === i) continue;
      let dx = x - (this.sumX[c] as number) / mc;
      let dy = y - (this.sumY[c] as number) / mc;
      let d2 = dx * dx + dy * dy;
      const s = this.size[c] as number;
      if (kind === INTERNAL && s * s >= THETA * THETA * d2) {
        const first = this.firstChild[c] as number;
        stack.push(first, first + 1, first + 2, first + 3);
        continue;
      }
      if (d2 < TINY) {
        // Two notes on one spot: nudge apart along a direction fixed by the sorted index
        // pair, so both get exactly opposite pushes and the result stays deterministic.
        if (kind < 0) {
          // A crowd of notes on (nearly) one spot, likely holding i: push i out along its
          // own golden-angle direction so the crowd fans out instead of staying stuck.
          const others = mc - mi;
          if (others <= 0) continue;
          const f = (REPULSION * mi * others) / 1e-4;
          ax += Math.cos(i * GOLDEN_ANGLE) * 0.01 * f;
          ay += Math.sin(i * GOLDEN_ANGLE) * 0.01 * f;
          continue;
        }
        const lo = Math.min(i, kind);
        const hi = Math.max(i, kind);
        const angle = ((lo * 7919 + hi * 104729) % 360) * (Math.PI / 180);
        const sign = i === lo ? 1 : -1;
        dx = Math.cos(angle) * 0.01 * sign;
        dy = Math.sin(angle) * 0.01 * sign;
        d2 = dx * dx + dy * dy;
      }
      const f = (REPULSION * mi * mc) / d2;
      ax += dx * f;
      ay += dy * f;
    }
    fx[i] = (fx[i] as number) + ax;
    fy[i] = (fy[i] as number) + ay;
  }
}
