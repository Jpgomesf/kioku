// A d3-force-style simulation with Obsidian's four forces (center, repel, link force and link
// distance) and a separation force of our own that pulls each cluster (a colour group or a
// region of the graph) towards its own place. Pure and deterministic for a seed, so an area
// always opens with the same picture.
//
// Why d3's model: Obsidian's graph view is built on it, and its "alpha" cooling lets the
// layout be reheated from the current positions when a slider moves, so notes glide to the
// new balance instead of jumping to a fresh layout. Dragging works as in d3 too: the dragged
// note is pinned, alpha is held at a target so the rest keeps moving around it, and the target
// drops to 0 on release so everything settles. Repulsion uses a Barnes-Hut quadtree, so one
// tick costs O(n log n).
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
  /**
   * Start positions; known[i] = 1 where they apply. `anchors` are the separation anchors those
   * positions settled under (Simulation.anchors), for a restart of the same graph and clusters:
   * it carries on from the same balance instead of finding anchors anew, so nothing drifts.
   */
  initial?: { xs: Float64Array; ys: Float64Array; known: Uint8Array; anchors?: Float64Array };
  /** Each note's cluster (any number from 0 up), -1 for none: see the separation force. */
  clusters?: Int32Array;
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
 * visibly across its range (with repelDamping below). repel 10 is a d3 charge of -1000 before
 * damping (d3's -30 is far too weak for a big area); center 0.52 is a forceX strength of
 * about 0.2.
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
/**
 * The separation force per unit of its slider, calibrated on 2,000 notes and 16,000 links in
 * a dozen clusters. With regions (clusters the links already favour), 0.5 sorts nearly every
 * note into its cluster with clear gaps between them, and 1 widens the gaps while each
 * cluster keeps more than half its unseparated breadth. Colour groups that the links ignore
 * are the hard case: 0.5 sorts most notes (their nearest note is in their group about 70% of
 * the time, against 10% unseparated) and 1 nearly all. 1 is a pull about three times the
 * default center force's. The gaps come from how tightly each cluster gathers, because the
 * anchors follow the notes' spread.
 */
const SEPARATION_SCALE = 0.6;
/** d3's distanceMin: closer notes repel as if they were this far apart. */
const DISTANCE_MIN2 = 1;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Stops the quadtree from splitting forever when notes sit on the same spot. */
const MAX_DEPTH = 24;
const TINY = 1e-9;
/** Passes that push overlapping cluster circles apart (anchorsFromNotes); a dozen clusters
 * stop overlapping in far fewer. */
const PUSH_PASSES = 40;

/** The clusters the separation force sorts notes into, and where each one goes. */
interface Clusters {
  /** Each note's cluster, renumbered from 0; -1 for none. */
  of: Int32Array;
  /** Notes per cluster. */
  sizes: Float64Array;
  /** Each cluster's anchor as x, y pairs about the clustered notes' centre, in units where a
   * cluster's circle has a radius of the square root of its size. */
  unit: Float64Array;
  /** How far the notes would spread (root mean square) if each cluster filled its circle. */
  unitSpread: number;
  /** How far the packed anchors sit from the centre (root mean square, by size): the scale
   * anchors taken from the notes are given, so their gaps come out as on a cold start. */
  packedRadius: number;
  /** This tick's anchors in world units, as x, y pairs. */
  anchor: Float64Array;
}

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
  /** d3's fx and fy: a pinned note (pinned[i] = 1) is held at fx[i], fy[i] with no velocity. */
  private readonly pinned: Uint8Array;
  private readonly fx: Float64Array;
  private readonly fy: Float64Array;
  private forces: Forces;
  private clusters: Clusters | null;
  private alphaValue: number;
  private alphaTargetValue = 0;

  constructor(input: SimulationInput, forces: Forces) {
    const n = Math.max(0, Math.floor(input.n) || 0);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.pinned = new Uint8Array(n);
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    this.links = cleanLinks(n, input.edges);
    this.rand = seededRandom(input.seed);
    this.forces = { ...forces };
    this.clusters = input.clusters ? clusterLayout(input.clusters, n) : null;
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
    // Clusters meeting a laid-out graph keep their places: a restart takes back the anchors
    // its layout settled under, other warm starts take them from the notes (anchorsFromNotes).
    // A cold start, every note on the spiral, keeps the packing.
    if (warm && this.clusters && !takeAnchors(this.clusters, input.initial?.anchors)) {
      anchorsFromNotes(this.clusters, this.xs, this.ys);
    }
    this.alphaValue = warm ? WARM_ALPHA : 1;
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get alphaTarget(): number {
    return this.alphaTargetValue;
  }

  /** At rest: cooled down, and not held warm by a drag. */
  get settled(): boolean {
    return this.alphaValue < ALPHA_MIN && this.alphaTargetValue < ALPHA_MIN;
  }

  /** The separation anchors in use, for a later restart of the same graph and clusters
   * (SimulationInput.initial.anchors); null while the force is off. */
  anchors(): Float64Array | null {
    return this.clusters && this.forces.separation > 0 ? this.clusters.unit.slice() : null;
  }

  /** New forces; the simulation reheats so the notes move to the new balance. */
  setForces(forces: Forces): void {
    const separating = this.forces.separation <= 0 && forces.separation > 0;
    this.forces = { ...forces };
    // Clusters that had no pull until now start from where the layout already put them.
    if (separating && this.clusters) anchorsFromNotes(this.clusters, this.xs, this.ys);
    this.reheat(Math.max(this.alphaValue, WARM_ALPHA));
  }

  /** New clusters, or null for none; the notes move to their new places, each cluster
   * starting from where its notes already are. */
  setClusters(clusters: Int32Array | null): void {
    const before = this.clusters;
    this.clusters = clusters ? clusterLayout(clusters, this.xs.length) : null;
    if (this.clusters) anchorsFromNotes(this.clusters, this.xs, this.ys);
    // Without separation clusters change nothing, so the picture stays still, as it does
    // going from nothing to separate to nothing again.
    if (this.forces.separation > 0 && (before || this.clusters)) {
      this.reheat(Math.max(this.alphaValue, WARM_ALPHA));
    }
  }

  reheat(alpha: number): void {
    this.alphaValue = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : WARM_ALPHA;
  }

  /** d3's alphaTarget: each tick moves alpha towards it. A drag holds it at 0.3 so the whole
   * graph stays live around the dragged note; 0 lets it cool and settle. */
  setAlphaTarget(target: number): void {
    this.alphaTargetValue = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  }

  /**
   * Holds a note at x, y, as d3's fx and fy: the forces still feel it, so its neighbours are
   * pulled after it, but it does not move until unpinned. False for a bad index or point.
   */
  pin(index: number, x: number, y: number): boolean {
    if (!this.has(index) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.pinned[index] = 1;
    this.fx[index] = x;
    this.fy[index] = y;
    // In place at once, so a post before the next tick already shows the note there.
    this.xs[index] = x;
    this.ys[index] = y;
    this.vx[index] = 0;
    this.vy[index] = 0;
    return true;
  }

  /** Lets a pinned note go; it starts still, then the forces move it again. */
  unpin(index: number): void {
    if (this.has(index)) this.pinned[index] = 0;
  }

  tick(): void {
    const n = this.xs.length;
    if (n === 0) {
      this.alphaValue = 0;
      return;
    }
    this.alphaValue += (this.alphaTargetValue - this.alphaValue) * ALPHA_DECAY;
    const alpha = this.alphaValue;
    this.applyLinks(alpha);
    this.applyRepel(alpha);
    this.applyCenter(alpha);
    this.applySeparation(alpha);
    const { xs, ys, vx, vy, pinned } = this;
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] === 1) {
        xs[i] = this.fx[i] as number;
        ys[i] = this.fy[i] as number;
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
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

  private has(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.xs.length;
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

  /**
   * The separation force: d3's forceX and forceY towards each cluster's anchor. The anchors
   * are one circle per cluster, sized by its notes and placed without overlaps (packed on a
   * cold start, taken from the notes on a warm one), centred on the clustered notes and scaled
   * each tick to how far they spread. So the force sorts notes into their places without
   * growing or shrinking the whole picture, whatever the other sliders say; the gaps between
   * clusters come from how tightly each one gathers.
   */
  private applySeparation(alpha: number): void {
    const k = this.forces.separation * SEPARATION_SCALE * alpha;
    const c = this.clusters;
    if (!c || k <= 0) return;
    const { xs, ys, vx, vy } = this;
    const { of, unit, anchor } = c;
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (let i = 0; i < of.length; i += 1) {
      if ((of[i] as number) < 0) continue;
      cx += xs[i] as number;
      cy += ys[i] as number;
      count += 1;
    }
    if (count === 0) return;
    cx /= count;
    cy /= count;
    let spread = 0;
    for (let i = 0; i < of.length; i += 1) {
      if ((of[i] as number) < 0) continue;
      spread += ((xs[i] as number) - cx) ** 2 + ((ys[i] as number) - cy) ** 2;
    }
    const scale = Math.sqrt(spread / count) / c.unitSpread;
    if (!Number.isFinite(scale)) return;
    for (let g = 0; g < c.sizes.length; g += 1) {
      anchor[2 * g] = cx + (unit[2 * g] as number) * scale;
      anchor[2 * g + 1] = cy + (unit[2 * g + 1] as number) * scale;
    }
    for (let i = 0; i < of.length; i += 1) {
      const g = of[i] as number;
      if (g < 0) continue;
      vx[i] = (vx[i] as number) + ((anchor[2 * g] as number) - (xs[i] as number)) * k;
      vy[i] = (vy[i] as number) + ((anchor[2 * g + 1] as number) - (ys[i] as number)) * k;
    }
  }
}

/** Run a simulation until it rests (or maxTicks) and return the positions, with the anchors
 * they settled under for a later restart (Simulation.anchors). */
export function settle(
  input: SimulationInput,
  forces: Forces,
  maxTicks = 400,
): { xs: Float64Array; ys: Float64Array; anchors: Float64Array | null } {
  const sim = new Simulation(input, forces);
  for (let t = 0; t < maxTicks && !sim.settled; t += 1) sim.tick();
  return { xs: sim.xs, ys: sim.ys, anchors: sim.anchors() };
}

/**
 * The clusters of `input` (-1 or anything not a cluster number is none), renumbered, with
 * their anchors packed. Null when there is nothing to separate: no note in a cluster, or one
 * cluster holding every note, whose pull would only shrink the whole graph. One cluster
 * beside notes in none still gathers, so a single colour group can be pulled together.
 */
function clusterLayout(input: Int32Array, n: number): Clusters | null {
  const ids = new Map<number, number>();
  const of = new Int32Array(n).fill(-1);
  const counts: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = input[i];
    if (id === undefined || id < 0) continue;
    let g = ids.get(id);
    if (g === undefined) {
      g = counts.length;
      ids.set(id, g);
      counts.push(0);
    }
    counts[g] = (counts[g] as number) + 1;
    of[i] = g;
  }
  if (counts.length === 0 || (counts.length === 1 && counts[0] === n)) return null;
  const sizes = Float64Array.from(counts);
  const unit = packClusters(counts);
  return {
    of,
    sizes,
    unit,
    unitSpread: anchorSpread(sizes, unit, true),
    packedRadius: anchorSpread(sizes, unit, false),
    anchor: new Float64Array(unit.length),
  };
}

/**
 * How far anchors spread about the origin (root mean square, by cluster size). With `filled`,
 * the spread they stand for: each cluster's anchor plus the spread of notes filling its circle
 * evenly (radius squared over 2, and a radius squared is its size).
 */
function anchorSpread(sizes: Float64Array, unit: Float64Array, filled: boolean): number {
  let total = 0;
  let sum = 0;
  sizes.forEach((s, g) => {
    total += s;
    sum += s * ((unit[2 * g] as number) ** 2 + (unit[2 * g + 1] as number) ** 2);
    if (filled) sum += (s * s) / 2;
  });
  return Math.sqrt(sum / total);
}

/** Takes anchors from an earlier run of the same clusters (Simulation.anchors) when they fit:
 * one finite pair per cluster. */
function takeAnchors(c: Clusters, anchors: Float64Array | undefined): boolean {
  if (!anchors || anchors.length !== c.unit.length || !anchors.every(Number.isFinite)) {
    return false;
  }
  const unit = anchors.slice();
  const unitSpread = anchorSpread(c.sizes, unit, true);
  if (!(unitSpread > 0) || !Number.isFinite(unitSpread)) return false;
  c.unit = unit;
  c.unitSpread = unitSpread;
  return true;
}

/**
 * Anchors from where each cluster already is, for clusters that meet a laid-out graph: a warm
 * start, new clusters, or separation turned up from 0. The packing places clusters by size
 * rank, so regions found afresh after a filter, or separation switched on over a settled
 * layout, would send clusters across the picture to slots that have nothing to do with where
 * they are. Instead each anchor starts at its cluster's centroid, scaled so the anchors sit as
 * far out as the packing's would, so the gaps come out as on a cold start; overlapping circles
 * are then pushed apart. When the centroids all coincide, the anchors stay as they were.
 */
function anchorsFromNotes(c: Clusters, xs: Float64Array, ys: Float64Array): void {
  const { of, sizes } = c;
  const k = sizes.length;
  const unit = new Float64Array(2 * k);
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (let i = 0; i < of.length; i += 1) {
    const g = of[i] as number;
    if (g < 0) continue;
    unit[2 * g] = (unit[2 * g] as number) + (xs[i] as number);
    unit[2 * g + 1] = (unit[2 * g + 1] as number) + (ys[i] as number);
    cx += xs[i] as number;
    cy += ys[i] as number;
    total += 1;
  }
  cx /= total;
  cy /= total;
  // Centroids about the clustered notes' centre, which is also their mean by size.
  for (let g = 0; g < k; g += 1) {
    const s = sizes[g] as number;
    unit[2 * g] = (unit[2 * g] as number) / s - cx;
    unit[2 * g + 1] = (unit[2 * g + 1] as number) / s - cy;
  }
  const radius = anchorSpread(sizes, unit, false);
  if (!(radius > 1e-6)) return;
  const scale = c.packedRadius / radius;
  for (let j = 0; j < unit.length; j += 1) unit[j] = (unit[j] as number) * scale;
  pushApart(unit, sizes);
  // Pushing moves the size-weighted centre a little: put it back on the notes' centre.
  let mx = 0;
  let my = 0;
  for (let g = 0; g < k; g += 1) {
    mx += (sizes[g] as number) * (unit[2 * g] as number);
    my += (sizes[g] as number) * (unit[2 * g + 1] as number);
  }
  for (let g = 0; g < k; g += 1) {
    unit[2 * g] = (unit[2 * g] as number) - mx / total;
    unit[2 * g + 1] = (unit[2 * g + 1] as number) - my / total;
  }
  const unitSpread = anchorSpread(sizes, unit, true);
  if (!Number.isFinite(unitSpread) || !unit.every(Number.isFinite)) return;
  c.unit = unit;
  c.unitSpread = unitSpread;
}

/**
 * Pushes overlapping cluster circles (each at its anchor, with a radius of the square root of
 * its size) apart along the line between them, the smaller one moving more, until none
 * overlap or the passes run out. Each pass sorts the circles by their left edge and compares
 * each only with those starting before its right edge, so thousands of small clusters stay
 * cheap.
 */
function pushApart(unit: Float64Array, sizes: Float64Array): void {
  const k = sizes.length;
  const r = sizes.map(Math.sqrt);
  const left = (g: number) => (unit[2 * g] as number) - (r[g] as number);
  const order = Array.from({ length: k }, (_, g) => g);
  for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
    order.sort((p, q) => left(p) - left(q) || p - q);
    let moved = false;
    for (let i = 0; i < k; i += 1) {
      const a = order[i] as number;
      const ra = r[a] as number;
      for (let j = i + 1; j < k; j += 1) {
        const b = order[j] as number;
        // This one, and every later one, starts past a's right edge.
        if (left(b) >= (unit[2 * a] as number) + ra) break;
        const dx = (unit[2 * b] as number) - (unit[2 * a] as number);
        const dy = (unit[2 * b + 1] as number) - (unit[2 * a + 1] as number);
        const min = ra + (r[b] as number);
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        // Apart along the line between them, or along an angle fixed by the pair when they
        // sit on the same spot.
        const same = d2 < TINY;
        const d = same ? 0 : Math.sqrt(d2);
        const angle = (a * GOLDEN_ANGLE + b) % (2 * Math.PI);
        const ux = same ? Math.cos(angle) : dx / d;
        const uy = same ? Math.sin(angle) : dy / d;
        const push = min - d;
        const sa = sizes[a] as number;
        const sb = sizes[b] as number;
        const shareA = sb / (sa + sb);
        unit[2 * a] = (unit[2 * a] as number) - ux * push * shareA;
        unit[2 * a + 1] = (unit[2 * a + 1] as number) - uy * push * shareA;
        unit[2 * b] = (unit[2 * b] as number) + ux * push * (1 - shareA);
        unit[2 * b + 1] = (unit[2 * b + 1] as number) + uy * push * (1 - shareA);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/**
 * Anchors for clusters of the given sizes: one circle per cluster with an area in proportion
 * to its notes, packed tightly with the largest first (so the big ones sit in the middle and
 * small ones around them), then centred on the notes' centre of mass. As x, y pairs, in input
 * order.
 */
export function packClusters(sizes: readonly number[]): Float64Array {
  const order = sizes
    .map((_, g) => g)
    .sort((p, q) => (sizes[q] as number) - (sizes[p] as number) || p - q);
  const r = Float64Array.from(order, (g) => Math.sqrt(Math.max(0, sizes[g] as number)));
  const { x, y } = packCircles(r);
  let total = 0;
  let cx = 0;
  let cy = 0;
  order.forEach((g, k) => {
    const s = sizes[g] as number;
    total += s;
    cx += s * (x[k] as number);
    cy += s * (y[k] as number);
  });
  if (total > 0) {
    cx /= total;
    cy /= total;
  }
  const out = new Float64Array(sizes.length * 2);
  order.forEach((g, k) => {
    out[2 * g] = (x[k] as number) - cx;
    out[2 * g + 1] = (y[k] as number) - cy;
  });
  return out;
}

/**
 * Packs circles so none overlap, each placed against the front chain of those already placed
 * where it lands closest to the middle: the front-chain method of Wang et al. (2006), as d3's
 * packSiblings does it.
 */
function packCircles(r: Float64Array): { x: Float64Array; y: Float64Array } {
  const n = r.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  if (n < 2) return { x, y };
  x[0] = -(r[1] as number);
  x[1] = r[0] as number;
  if (n === 2) return { x, y };

  /** Places circle c against circles a and b (outside the chain, as seen from a to b). */
  const place = (b: number, a: number, c: number) => {
    const dx = (x[b] as number) - (x[a] as number);
    const dy = (y[b] as number) - (y[a] as number);
    const d2 = dx * dx + dy * dy;
    if (d2 === 0) {
      x[c] = (x[a] as number) + (r[c] as number);
      y[c] = y[a] as number;
      return;
    }
    const a2 = ((r[a] as number) + (r[c] as number)) ** 2;
    const b2 = ((r[b] as number) + (r[c] as number)) ** 2;
    if (a2 > b2) {
      const u = (d2 + b2 - a2) / (2 * d2);
      const v = Math.sqrt(Math.max(0, b2 / d2 - u * u));
      x[c] = (x[b] as number) - u * dx - v * dy;
      y[c] = (y[b] as number) - u * dy + v * dx;
    } else {
      const u = (d2 + a2 - b2) / (2 * d2);
      const v = Math.sqrt(Math.max(0, a2 / d2 - u * u));
      x[c] = (x[a] as number) + u * dx - v * dy;
      y[c] = (y[a] as number) + u * dy + v * dx;
    }
  };
  const intersects = (a: number, b: number) => {
    const dr = (r[a] as number) + (r[b] as number) - 1e-6;
    const dx = (x[b] as number) - (x[a] as number);
    const dy = (y[b] as number) - (y[a] as number);
    return dr > 0 && dr * dr > dx * dx + dy * dy;
  };
  // How far from the middle the gap between a chain circle and the next one is.
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  const score = (a: number) => {
    const b = next[a] as number;
    const ab = (r[a] as number) + (r[b] as number);
    const dx = ((x[a] as number) * (r[b] as number) + (x[b] as number) * (r[a] as number)) / ab;
    const dy = ((y[a] as number) * (r[b] as number) + (y[b] as number) * (r[a] as number)) / ab;
    return dx * dx + dy * dy;
  };

  place(1, 0, 2);
  // The front chain starts as the first three circles, a to b to c and round.
  let a = 0;
  let b = 1;
  next[0] = 1;
  next[1] = 2;
  next[2] = 0;
  prev[1] = 0;
  prev[2] = 1;
  prev[0] = 2;
  for (let i = 3; i < n; i += 1) {
    place(a, b, i);
    // The nearest chain circle (along the chain) that the new one overlaps, if any: the
    // chain is cut back to it and the new circle tried again.
    let j = next[b] as number;
    let k = prev[a] as number;
    let sj = r[b] as number;
    let sk = r[a] as number;
    let blocked = false;
    do {
      if (sj <= sk) {
        if (intersects(j, i)) {
          b = j;
          blocked = true;
          break;
        }
        sj += r[j] as number;
        j = next[j] as number;
      } else {
        if (intersects(k, i)) {
          a = k;
          blocked = true;
          break;
        }
        sk += r[k] as number;
        k = prev[k] as number;
      }
    } while (j !== next[k]);
    if (blocked) {
      next[a] = b;
      prev[b] = a;
      i -= 1;
      continue;
    }
    // It fits: insert it between a and b, then start the next one at the chain's gap
    // closest to the middle.
    prev[i] = a;
    next[i] = b;
    next[a] = i;
    prev[b] = i;
    b = i;
    let best = a;
    let bestScore = score(a);
    for (let c = next[i] as number; c !== i; c = next[c] as number) {
      const sc = score(c);
      if (sc < bestScore) {
        best = c;
        bestScore = sc;
      }
    }
    a = best;
    b = next[a] as number;
  }
  return { x, y };
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
