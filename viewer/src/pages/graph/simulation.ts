// A d3-force-style simulation with Obsidian's four forces: center, repel, link force and link
// distance. Pure and deterministic for a seed, so an area always opens with the same picture.
//
// Why d3's model: Obsidian's graph view is built on it, and its "alpha" cooling lets the
// layout be reheated from the current positions when a slider moves, so notes glide to the
// new balance instead of jumping to a fresh layout. Repulsion uses a Barnes-Hut quadtree,
// so one tick costs O(n log n).
import type { Forces } from "./forces";

/** A 32-bit string hash (FNV-1a). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast seeded generator in [0, 1). Lives here, not in layout.ts, so the
 * worker bundle does not pull in React. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulationInput {
  n: number;
  edges: ReadonlyArray<readonly [number, number]>;
  seed: number;
  /** Start positions; known[i] = 1 where they apply. */
  initial?: { xs: Float64Array; ys: Float64Array; known: Uint8Array };
}

/** d3's cooling: alpha decays from 1 to ALPHA_MIN in about 300 ticks. */
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);
/** Warm starts and slider changes begin here, so the picture moves but does not scramble. */
const WARM_ALPHA = 0.3;
const VELOCITY_DECAY = 0.4;
const THETA2 = 0.9 * 0.9;
/**
 * Scales from Obsidian's slider values to d3 strengths, calibrated on 2,000 notes and 16,000
 * links: at the defaults the area spreads with no dense core (the inner quarter of the radius
 * holds about the share of notes an even disc would), and each slider moves the spread
 * visibly across its range (with repelDamping below). repel 10 is a d3 charge of -1000 before damping (d3's -30 is far too weak for
 * a big area); center 0.52 is a forceX strength of about 0.2.
 */
const REPEL_SCALE = 100;
const CENTER_SCALE = 0.4;
/**
 * Total repulsion grows with the number of notes, and with many links the springs (d3's
 * 1/min(degree) strength) get weak, so on a big area every link stayed far longer than the
 * whole distance slider and the slider did nothing. Damping the charge by the square root of
 * the area's size (notes plus links, against a 300 baseline) keeps link lengths near the
 * slider's range: on 2,000 notes and 16,000 links, distance 500 gives links about 1.4 times
 * as long as distance 30. Small areas (under the baseline) are unchanged.
 */
function repelDamping(notes: number, links: number): number {
  return Math.max(1, Math.sqrt((notes + links) / 300));
}
/** d3's distanceMin: closer notes repel as if they were this far apart. */
const DISTANCE_MIN2 = 1;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Stops the quadtree from splitting forever when notes sit on the same spot. */
const MAX_DEPTH = 24;
const TINY = 1e-9;

export class Simulation {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  /** Links as a flat array of index pairs, cleaned. */
  private readonly links: Int32Array;
  private readonly linkStrength: Float64Array;
  private readonly linkBias: Float64Array;
  private readonly tree: QuadTree;
  private readonly rand: () => number;
  private forces: Forces;
  private alphaValue: number;

  constructor(input: SimulationInput, forces: Forces) {
    const n = Math.max(0, Math.floor(input.n) || 0);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.links = cleanLinks(n, input.edges);
    this.rand = seededRandom(input.seed);
    this.forces = { ...forces };
    this.tree = new QuadTree(n);

    // d3's link defaults: strength 1/min(degree) so hubs do not drag everything in, and a
    // bias that moves the less linked end more.
    const degree = new Float64Array(n);
    for (const i of this.links) degree[i] = (degree[i] as number) + 1;
    const m = this.links.length / 2;
    this.linkStrength = new Float64Array(m);
    this.linkBias = new Float64Array(m);
    for (let e = 0; e < m; e += 1) {
      const a = degree[this.links[2 * e] as number] as number;
      const b = degree[this.links[2 * e + 1] as number] as number;
      this.linkStrength[e] = 1 / Math.max(1, Math.min(a, b));
      this.linkBias[e] = a / (a + b);
    }

    const warm = this.place(input);
    this.alphaValue = warm ? WARM_ALPHA : 1;
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get settled(): boolean {
    return this.alphaValue < ALPHA_MIN;
  }

  /** New forces; the simulation reheats so the notes move to the new balance. */
  setForces(forces: Forces): void {
    this.forces = { ...forces };
    this.reheat(Math.max(this.alphaValue, WARM_ALPHA));
  }

  reheat(alpha: number): void {
    this.alphaValue = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : WARM_ALPHA;
  }

  tick(): void {
    const n = this.xs.length;
    if (n === 0) {
      this.alphaValue = 0;
      return;
    }
    this.alphaValue += (0 - this.alphaValue) * ALPHA_DECAY;
    const alpha = this.alphaValue;
    this.applyLinks(alpha);
    this.applyRepel(alpha);
    this.applyCenter(alpha);
    const { xs, ys, vx, vy } = this;
    for (let i = 0; i < n; i += 1) {
      const nvx = (vx[i] as number) * (1 - VELOCITY_DECAY);
      const nvy = (vy[i] as number) * (1 - VELOCITY_DECAY);
      // A broken force must never poison a position: drop that note's move instead.
      if (!Number.isFinite(nvx) || !Number.isFinite(nvy)) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      xs[i] = (xs[i] as number) + nvx;
      ys[i] = (ys[i] as number) + nvy;
    }
  }

  /**
   * Start positions. Known notes keep theirs; a new note starts near a linked known note,
   * else on d3's phyllotaxis spiral with a little seeded jitter. Returns true on a warm start.
   */
  private place(input: SimulationInput): boolean {
    const n = this.xs.length;
    const initial = input.initial;
    const known = new Uint8Array(n);
    if (initial) {
      for (let i = 0; i < n; i += 1) {
        const x = initial.xs[i];
        const y = initial.ys[i];
        if (initial.known[i] === 1 && Number.isFinite(x) && Number.isFinite(y)) {
          this.xs[i] = x as number;
          this.ys[i] = y as number;
          known[i] = 1;
        }
      }
    }
    const warm = known.some((k) => k === 1);
    const anchor = new Int32Array(n).fill(-1);
    if (warm) {
      for (let e = 0; e < this.links.length; e += 2) {
        const a = this.links[e] as number;
        const b = this.links[e + 1] as number;
        if (known[a] === 1 && known[b] === 0 && anchor[b] === -1) anchor[b] = a;
        if (known[b] === 1 && known[a] === 0 && anchor[a] === -1) anchor[a] = b;
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (known[i] === 1) continue;
      const near = anchor[i] as number;
      if (near >= 0) {
        const a = this.rand() * 2 * Math.PI;
        const r = 0.2 * this.forces.distance * (0.5 + this.rand());
        this.xs[i] = (this.xs[near] as number) + r * Math.cos(a);
        this.ys[i] = (this.ys[near] as number) + r * Math.sin(a);
        continue;
      }
      // d3's spiral, a bit wider so a big area does not start as one hot ball.
      const r = 10 * Math.sqrt(0.5 + i);
      const a = i * GOLDEN_ANGLE;
      this.xs[i] = r * Math.cos(a) + this.rand() - 0.5;
      this.ys[i] = r * Math.sin(a) + this.rand() - 0.5;
    }
    return warm;
  }

  /** d3 forceLink: springs towards the link distance, one pass per tick. */
  private applyLinks(alpha: number): void {
    const { xs, ys, vx, vy, links } = this;
    const k = this.forces.link * alpha;
    if (k <= 0) return;
    const distance = this.forces.distance;
    for (let e = 0; e < links.length / 2; e += 1) {
      const s = links[2 * e] as number;
      const t = links[2 * e + 1] as number;
      let dx = (xs[t] as number) + (vx[t] as number) - (xs[s] as number) - (vx[s] as number);
      let dy = (ys[t] as number) + (vy[t] as number) - (ys[s] as number) - (vy[s] as number);
      if (dx * dx + dy * dy < TINY) {
        // Coincident ends: a fixed nudge along the link's own angle, so no division by zero.
        const angle = e * GOLDEN_ANGLE;
        dx = Math.cos(angle) * 1e-3;
        dy = Math.sin(angle) * 1e-3;
      }
      const l = Math.sqrt(dx * dx + dy * dy);
      const f = ((l - distance) / l) * k * (this.linkStrength[e] as number);
      dx *= f;
      dy *= f;
      const b = this.linkBias[e] as number;
      vx[t] = (vx[t] as number) - dx * b;
      vy[t] = (vy[t] as number) - dy * b;
      vx[s] = (vx[s] as number) + dx * (1 - b);
      vy[s] = (vy[s] as number) + dy * (1 - b);
    }
  }

  /** d3 forceManyBody with Barnes-Hut. */
  private applyRepel(alpha: number): void {
    const strength =
      (this.forces.repel * REPEL_SCALE) / repelDamping(this.xs.length, this.links.length / 2);
    if (strength <= 0 || this.xs.length < 2) return;
    this.tree.build(this.xs, this.ys);
    for (let i = 0; i < this.xs.length; i += 1) {
      this.tree.repel(i, this.xs, this.ys, strength * alpha, this.vx, this.vy);
    }
  }

  /** d3 forceX and forceY towards the origin. */
  private applyCenter(alpha: number): void {
    const k = this.forces.center * CENTER_SCALE * alpha;
    if (k <= 0) return;
    const { xs, ys, vx, vy } = this;
    for (let i = 0; i < xs.length; i += 1) {
      vx[i] = (vx[i] as number) - (xs[i] as number) * k;
      vy[i] = (vy[i] as number) - (ys[i] as number) * k;
    }
  }
}

/** Run a simulation until it rests (or maxTicks) and return the positions. */
export function settle(
  input: SimulationInput,
  forces: Forces,
  maxTicks = 400,
): { xs: Float64Array; ys: Float64Array } {
  const sim = new Simulation(input, forces);
  for (let t = 0; t < maxTicks && !sim.settled; t += 1) sim.tick();
  return { xs: sim.xs, ys: sim.ys };
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

const EMPTY = -1;
const INTERNAL = -2;
/** A leaf at MAX_DEPTH holding several notes on (nearly) the same spot. */
const CROWD = -3;

/** A Barnes-Hut quadtree in flat arrays, rebuilt every tick. Every note weighs 1. */
class QuadTree {
  private x0: number[] = [];
  private y0: number[] = [];
  private size: number[] = [];
  private count: number[] = [];
  private sumX: number[] = [];
  private sumY: number[] = [];
  private firstChild: number[] = [];
  private body: number[] = [];
  private depth: number[] = [];
  private cells = 0;
  private readonly stack: number[] = [];

  private readonly n: number;

  constructor(n: number) {
    this.n = n;
  }

  build(xs: Float64Array, ys: Float64Array): void {
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
    this.cells = 0;
    this.addCell(minX - side * 0.005, minY - side * 0.005, side, 0);
    for (let i = 0; i < this.n; i += 1) this.insert(i, xs, ys);
  }

  private addCell(x0: number, y0: number, size: number, depth: number): number {
    const c = this.cells;
    this.x0[c] = x0;
    this.y0[c] = y0;
    this.size[c] = size;
    this.count[c] = 0;
    this.sumX[c] = 0;
    this.sumY[c] = 0;
    this.firstChild[c] = -1;
    this.body[c] = EMPTY;
    this.depth[c] = depth;
    this.cells += 1;
    return c;
  }

  private quadrant(c: number, x: number, y: number): number {
    const half = (this.size[c] as number) / 2;
    const right = x >= (this.x0[c] as number) + half ? 1 : 0;
    const down = y >= (this.y0[c] as number) + half ? 2 : 0;
    return (this.firstChild[c] as number) + right + down;
  }

  private add(c: number, x: number, y: number): void {
    this.count[c] = (this.count[c] as number) + 1;
    this.sumX[c] = (this.sumX[c] as number) + x;
    this.sumY[c] = (this.sumY[c] as number) + y;
  }

  private insert(i: number, xs: Float64Array, ys: Float64Array): void {
    const x = xs[i] as number;
    const y = ys[i] as number;
    let c = 0;
    for (;;) {
      const kind = this.body[c] as number;
      if (kind === INTERNAL) {
        this.add(c, x, y);
        c = this.quadrant(c, x, y);
        continue;
      }
      if (kind === EMPTY) {
        this.body[c] = i;
        this.add(c, x, y);
        return;
      }
      if (kind === CROWD || (this.depth[c] as number) >= MAX_DEPTH) {
        this.body[c] = CROWD;
        this.add(c, x, y);
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
      this.add(child, xs[j] as number, ys[j] as number);
    }
  }

  /** d3's many-body push on note i: k * count / distance, from near notes and far cells. */
  repel(
    i: number,
    xs: Float64Array,
    ys: Float64Array,
    k: number,
    vx: Float64Array,
    vy: Float64Array,
  ): void {
    const x = xs[i] as number;
    const y = ys[i] as number;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    let ax = 0;
    let ay = 0;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      let weight = this.count[c] as number;
      const kind = this.body[c] as number;
      if (weight <= 0 || kind === i) continue;
      let dx = x - (this.sumX[c] as number) / weight;
      let dy = y - (this.sumY[c] as number) / weight;
      let d2 = dx * dx + dy * dy;
      const s = this.size[c] as number;
      if (kind === INTERNAL && (s * s) / THETA2 >= d2) {
        const first = this.firstChild[c] as number;
        stack.push(first, first + 1, first + 2, first + 3);
        continue;
      }
      if (d2 < TINY) {
        // On the same spot: push along a direction fixed by the note, so a crowd fans out
        // deterministically instead of dividing by zero.
        if (kind === CROWD) weight -= 1; // the crowd likely holds i itself
        if (weight <= 0) continue;
        // A pair gets exactly opposite pushes along one angle fixed by its sorted indices; a
        // crowd member goes out along its own angle.
        const pair = kind >= 0;
        const lo = pair ? Math.min(i, kind) : i;
        const hi = pair ? Math.max(i, kind) : 0;
        const angle = (lo * GOLDEN_ANGLE + hi) % (2 * Math.PI);
        const sign = pair && i !== lo ? -1 : 1;
        dx = Math.cos(angle) * 1e-3 * sign;
        dy = Math.sin(angle) * 1e-3 * sign;
        d2 = dx * dx + dy * dy;
      }
      // d3's distanceMin keeps very near notes from flinging each other away.
      const l = d2 < DISTANCE_MIN2 ? Math.sqrt(DISTANCE_MIN2 * d2) : d2;
      const f = (k * weight) / l;
      ax += dx * f;
      ay += dy * f;
    }
    vx[i] = (vx[i] as number) + ax;
    vy[i] = (vy[i] as number) + ay;
  }
}
