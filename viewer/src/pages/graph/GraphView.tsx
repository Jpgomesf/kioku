// The stage: a canvas the GraphRenderer draws every note and link on, under an HTML overlay
// (labels and the focused neighbourhood's cards). The renderer owns the live camera: drag and
// wheel move it directly and React hears about it once a gesture ends, so a pan or zoom never
// re-renders the page per event. Buttons, keys and clicks animate it with animateTo; reduced
// motion makes those moves instant. The overlay follows the camera through renderer.subscribe.
//
// As in Obsidian, the canvas fills the page: the layout is a live simulation (useLiveLayout),
// the settings box floats open under its gear at the top right and the area button sits at the
// top left. A click selects a note without moving the camera. Hovering a note, or else the
// selected one, lights its own links out to the highlight depth and fades the rest. Dragging a
// note pulls it and the graph follows, as in d3. The camera fits the area only while it first
// opens (until the layout settles or the viewer takes the camera), on 0 and on Fit; after that
// it stays put, so a force change shows the notes moving instead of a re-fit that hides it.
// The graph can be coloured and separated by colour group or by brain region (the clusters its
// links form). The canvas names the clusters on screen, brain regions or colour groups, and
// topics, all in one collision-checked placement; the settings box lists the named clusters.
// Positions stream outside React: each update moves the dots in place (renderer.setPositions)
// and re-places the overlay, which follows notes by key.
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type GraphData, type GraphNode, kindCounts, type NoteKind, TOPIC_KIND } from "../../api";
import { hasCommandKey } from "../../app/overlay";
import { graphHref, parseHash } from "../../app/router";
import { EmptyState, IconButton } from "../../components/ui";
import { duration, usePrefersReducedMotion } from "../../motion";
import { ANIMATE_MS, partialScene, revealRanks } from "./animate";
import {
  type Camera,
  centreOn,
  dotGrid,
  fitCamera,
  frameCamera,
  type Level,
  levelFor,
  nextLevel,
  pan,
  STEPS,
  stepCamera,
  toScreen,
  toWorld,
  type Viewport,
  wheelFactor,
  zoomAt,
} from "./camera";
import { GraphSettings, type NamedPart } from "./GraphSettings";
import { Inspector } from "./Inspector";
import {
  alignPositions,
  type Bounds,
  type LivePositions,
  type Point,
  useLiveLayout,
  WORLD,
} from "./layout";
import {
  cardKey,
  cardSlots,
  cardsFor,
  formatCount,
  linkDepths,
  neighboursWithin,
  rankFrom,
} from "./model";
import { type CardPlace, Overlay } from "./Overlay";
import { DISTINCT_COLOURS, paletteColour } from "./palette";
import { OverlayPlacer } from "./placer";
import { groupColour, groupIndex, matchesQuery, parseQuery, type QueryTarget } from "./query";
import { groupNames, regionNames } from "./regions";
import { GraphRenderer } from "./renderer";
import type { Scene } from "./scene";
import { type GraphSettings as Settings, useGraphSettings, usePanelState } from "./settings";
import { isTagKey, withTags } from "./tags";
import { toScene } from "./toScene";

export interface GraphViewProps {
  domain: string;
  areaLabel: string;
  data: GraphData;
  initialFocus: string | undefined;
  areaButton: ReactNode;
}

const DEFAULT_VIEW: Viewport = { width: 1000, height: 640 };

/** Drawn until the layout has positions, so no pile of dots flashes at the origin. */
const EMPTY_SCENE: Scene = { nodes: [], edges: [] };

/** The colour of notes no group matches, until --type-other is read from the page. */
const OTHER_FALLBACK = "#8a8b93";
/** The colour of tag nodes no group matches, until --graph-tag is read from the page. */
const TAG_FALLBACK = "#9a8f7a";

/** The semantic zoom levels (Closer, Neighbourhood, a note) and their cards. Off: the graph
 * zooms freely, as in Obsidian. The user wants this code kept for a later detailed view, so
 * it stays wired behind this switch rather than deleted. */
const CARD_LEVELS = false as boolean;
/** How far the cards reach from the focus; the 2 hops switch went with the old header. */
const CARD_HOPS = 1;

/** The box the notes fill, or a world-sized box about the origin while there are none. */
function boundsOf(value: LivePositions | null): Bounds {
  const n = value?.xs.length ?? 0;
  if (!value || n === 0) {
    return {
      minX: -WORLD.width / 2,
      minY: -WORLD.height / 2,
      maxX: WORLD.width / 2,
      maxY: WORLD.height / 2,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const x = value.xs[i] as number;
    const y = value.ys[i] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

const sameCamera = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.s === b.s;

const targetOf = (n: GraphNode): QueryTarget => ({
  key: n.key,
  title: n.title,
  kind: n.kind,
  tags: n.tags,
});

/** Reads a colour token from the page; the canvas needs a concrete colour, not a var(). */
function readToken(el: HTMLElement | null, name: string, fallback: string): string {
  try {
    return (el ? getComputedStyle(el).getPropertyValue(name).trim() : "") || fallback;
  } catch {
    return fallback;
  }
}

/** Runs `fn` on the next frame; returns a cancel. Falls back to a timer without frames. */
function onFrame(fn: () => void): () => void {
  if (typeof window.requestAnimationFrame !== "function") {
    const t = window.setTimeout(fn, 16);
    return () => window.clearTimeout(t);
  }
  const f = window.requestAnimationFrame(fn);
  return () => window.cancelAnimationFrame(f);
}

/** A gesture counts as ended this long after the last wheel event. */
const WHEEL_IDLE_MS = 150;
/** A press that moves less than this is a click, not a drag. */
const DRAG_SLOP = 4;
/** Arrow-key pans are short moves, so they take the shorter view duration. */
const PAN_STEP = 48;

function useViewport(ref: React.RefObject<HTMLDivElement | null>): Viewport {
  const [view, setView] = useState<Viewport>(DEFAULT_VIEW);
  // Measured before paint, so the first frame already uses the real size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Keep the same object for the same size, so effects keyed on the view don't rerun.
      setView((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return view;
}

/** Moves the stage's dot grid with the camera, through the custom properties graph.css reads. */
function applyDotGrid(stage: HTMLElement | null, camera: Camera): void {
  if (!stage) return;
  const { gap, x, y } = dotGrid(camera);
  stage.style.setProperty("--dot-gap", `${gap}px`);
  stage.style.setProperty("--dot-x", `${x}px`);
  stage.style.setProperty("--dot-y", `${y}px`);
}

/** Runs `fn` after the next frame has been styled, so new elements can transition. */
function afterFrame(fn: () => void): () => void {
  if (typeof window.requestAnimationFrame !== "function") {
    const t = window.setTimeout(fn, 16);
    return () => window.clearTimeout(t);
  }
  let inner = 0;
  const outer = window.requestAnimationFrame(() => {
    inner = window.requestAnimationFrame(fn);
  });
  return () => {
    window.cancelAnimationFrame(outer);
    window.cancelAnimationFrame(inner);
  };
}

/** Calls the latest `fn`, through a callback that never changes (for memoised children). */
function useStableCallback<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

function wantsPerfProbe(): boolean {
  if (!import.meta.env.DEV) return false;
  const q = window.location.hash.indexOf("?");
  return q >= 0 && new URLSearchParams(window.location.hash.slice(q + 1)).get("perf") === "1";
}

const BG_OPACITY = [1, 1, 0.5, 0.2] as const;

export function GraphView({ domain, areaLabel, data, initialFocus, areaButton }: GraphViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const placerRef = useRef<OverlayPlacer | null>(null);
  const view = useViewport(stageRef);
  const reduced = usePrefersReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const byKey = useMemo(() => new Map(data.nodes.map((n) => [n.key, n])), [data]);

  // Settings: one colour group per type by default, saved per area once the viewer edits.
  const types = useMemo(() => kindCounts(data.nodes), [data]);
  const rank = useMemo(() => rankFrom(types.map((t) => t.kind)), [types]);
  const {
    settings,
    update: updateSettings,
    reset: resetSettings,
  } = useGraphSettings(domain, types);
  const [panel, setPanel] = usePanelState();
  const { filters, display } = settings;
  const [highlight, setHighlight] = useState<string | null>(null);

  // The canvas needs concrete colours, so --type-other and --graph-tag are read from the page
  // (and again on a theme change, below).
  const [otherColour, setOtherColour] = useState(OTHER_FALLBACK);
  const [tagColour, setTagColour] = useState(TAG_FALLBACK);
  const readColours = useCallback(() => {
    setOtherColour(readToken(stageRef.current, "--type-other", OTHER_FALLBACK));
    setTagColour(readToken(stageRef.current, "--graph-tag", TAG_FALLBACK));
  }, []);
  useLayoutEffect(readColours, [readColours]);

  const groups = useMemo(
    () => settings.groups.map((g) => ({ query: parseQuery(g.query), color: g.color })),
    [settings.groups],
  );

  // Filters, as in Obsidian: the search query, legacy notes, suggested links, tags and orphans.
  // Tag nodes come from the notes the other filters keep, and their links count for orphans.
  const filterQuery = useMemo(() => parseQuery(filters.query), [filters.query]);
  const visibleData = useMemo((): GraphData => {
    const matching = data.nodes.filter(
      (n) => (filters.legacy || n.status !== "legacy") && matchesQuery(filterQuery, targetOf(n)),
    );
    const keys = new Set(matching.map((n) => n.key));
    const edges = data.edges.filter(
      (e) => keys.has(e.source) && keys.has(e.target) && (filters.suggested || !e.suggested),
    );
    const shown = filters.tags ? withTags({ nodes: matching, edges }) : { nodes: matching, edges };
    if (filters.orphans) return shown;
    const linked = new Set(shown.edges.flatMap((e) => [e.source, e.target]));
    return { nodes: shown.nodes.filter((n) => linked.has(n.key)), edges: shown.edges };
  }, [data, filterQuery, filters.legacy, filters.suggested, filters.tags, filters.orphans]);
  const visible = visibleData.nodes;
  const visibleEdges = visibleData.edges;
  const visibleKeys = useMemo(() => new Set(visible.map((n) => n.key)), [visible]);
  const visibleKeysRef = useRef(visibleKeys);
  visibleKeysRef.current = visibleKeys;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // What the separation force sorts notes by. For colour groups, each note's first matching
  // group, the same one its colour comes from (-1 for none); brain regions the layout finds.
  const { separateBy, colourBy } = settings.clusters;
  const clusterGroups = useMemo(
    () =>
      separateBy === "groups"
        ? Int32Array.from(visible, (n) => groupIndex(groups, targetOf(n)))
        : null,
    [separateBy, visible, groups],
  );
  const live = useLiveLayout(domain, visibleData, settings.forces, {
    mode: separateBy,
    groups: clusterGroups,
  });
  const liveRef = useRef(live);
  liveRef.current = live;

  // The brain regions the layout found for the visible notes, by key. They come with the first
  // positions and again once a filter changes the graph; until then a new note has none.
  // biome-ignore lint/correctness/useExhaustiveDependencies: regionsVersion marks new regions
  const regionOf = useMemo(() => {
    const found = live.regions();
    if (!found) return null;
    const at = new Map<string, number>();
    visible.forEach((n, i) => {
      const r = found.assign[i] ?? -1;
      if (r >= 0) at.set(n.key, r);
    });
    return { at, assign: found.assign, count: found.count };
  }, [live.regions, live.regionsVersion, visible]);

  // The brain regions' names, worked out once per set of regions while something uses them:
  // the canvas names them unless it names the colour groups, and colours go to named regions.
  const regionNamesUsed =
    colourBy === "regions" || (display.regionLabels && separateBy !== "groups");
  const regionNameList = useMemo(
    () =>
      regionNamesUsed && regionOf
        ? regionNames(visible, visibleEdges, regionOf.assign, regionOf.count)
        : null,
    [regionNamesUsed, regionOf, visible, visibleEdges],
  );

  // Colour by brain region: each of the largest named regions takes a palette colour by its
  // number, which it keeps as filters change the graph. Only the first DISTINCT_COLOURS are
  // clearly apart and the small unnamed regions would only scatter colour, so the rest stay
  // grey: each colour then stands for one region, with its name on the canvas.
  const regionColours = useMemo(() => {
    if (colourBy !== "regions" || !regionOf || !regionNameList) return null;
    const palette = Array.from({ length: regionOf.count }, (_, r) =>
      r < DISTINCT_COLOURS && regionNameList[r] !== "" ? paletteColour(r) : null,
    );
    return { at: regionOf.at, palette };
  }, [colourBy, regionOf, regionNameList]);
  const colourFor = useCallback(
    (n: GraphNode) => {
      const tag = isTagKey(n.key);
      if (regionColours) {
        // Tags are not notes: they keep their quiet colour, and notes in no region the grey.
        if (tag) return tagColour;
        const r = regionColours.at.get(n.key);
        return (r === undefined ? undefined : regionColours.palette[r]) ?? otherColour;
      }
      return groupColour(groups, targetOf(n)) ?? (tag ? tagColour : otherColour);
    },
    [groups, otherColour, tagColour, regionColours],
  );
  const colours = useMemo(
    () => new Map(visible.map((n) => [n.key, colourFor(n)])),
    [visible, colourFor],
  );
  const colourOf = useCallback(
    (n: GraphNode) => colours.get(n.key) ?? colourFor(n),
    [colours, colourFor],
  );

  // Each drawn note's linked notes, for the depths a hover or a selection lights.
  const adjacency = useMemo(() => {
    const out = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      const set = out.get(a);
      if (set) set.add(b);
      else out.set(a, new Set([b]));
    };
    for (const e of visibleEdges) {
      if (e.source === e.target) continue;
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return out;
  }, [visibleEdges]);
  const adjacencyRef = useRef(adjacency);
  adjacencyRef.current = adjacency;

  // What the canvas names while Region labels is on, by key: the clusters on screen. Those are
  // the colour groups while the graph is separated by them (a region's notes are then spread
  // over every group's cluster, so its name would float over clusters it doesn't describe),
  // and the brain regions otherwise. The renderer treats either as regions.
  const groupsNamed = separateBy === "groups";
  const canvasNames = useMemo(() => {
    if (!display.regionLabels) return null;
    let at: ReadonlyMap<string, number>;
    let names: readonly string[];
    if (groupsNamed) {
      if (!clusterGroups) return null;
      names = groupNames(
        visible,
        clusterGroups,
        settings.groups.map((g) => g.query),
      );
      const byKey = new Map<string, number>();
      visible.forEach((n, i) => {
        const g = clusterGroups[i] ?? -1;
        if (g >= 0) byKey.set(n.key, g);
      });
      at = byKey;
    } else {
      if (!regionOf || !regionNameList) return null;
      names = regionNameList;
      at = regionOf.at;
    }
    return names.some((name) => name !== "") ? { at, names } : null;
  }, [
    display.regionLabels,
    groupsNamed,
    clusterGroups,
    visible,
    settings.groups,
    regionOf,
    regionNameList,
  ]);
  const canvasNamesRef = useRef(canvasNames);
  canvasNamesRef.current = canvasNames;

  // The named clusters for the settings box, largest first, each with the colour its notes
  // share: its group's while groups both colour and gather the notes, its own while regions do.
  const namedParts = useMemo((): NamedPart[] => {
    if (!canvasNames) return [];
    const sizes = new Map<number, number>();
    for (const n of visible) {
      const id = canvasNames.at.get(n.key);
      if (id !== undefined && !isTagKey(n.key)) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    }
    const colourOfPart = (id: number): string | null => {
      if (groupsNamed) return colourBy === "groups" ? (settings.groups[id]?.color ?? null) : null;
      return regionColours ? (regionColours.palette[id] ?? otherColour) : null;
    };
    return canvasNames.names
      .flatMap((name, id) => (name === "" ? [] : [{ id, name, colour: colourOfPart(id) }]))
      .sort((p, q) => (sizes.get(q.id) ?? 0) - (sizes.get(p.id) ?? 0) || p.id - q.id);
  }, [canvasNames, visible, groupsNamed, colourBy, settings.groups, regionColours, otherColour]);

  // A note's live position, looked up through an index rebuilt when the layout's keys change.
  const keyIndex = useRef<{ keys: readonly string[] | null; at: Map<string, number> }>({
    keys: null,
    at: new Map(),
  });
  const posOf = useCallback((key: string): Point | null => {
    const v = liveRef.current.current();
    if (!v) return null;
    const idx = keyIndex.current;
    if (idx.keys !== v.keys) {
      idx.keys = v.keys;
      idx.at = new Map(v.keys.map((k, i) => [k, i]));
    }
    const i = idx.at.get(key);
    if (i === undefined) return null;
    return { x: v.xs[i] as number, y: v.ys[i] as number };
  }, []);

  const startFocus = initialFocus && byKey.has(initialFocus) ? initialFocus : null;
  const [missing, setMissing] = useState<string | null>(
    initialFocus && !startFocus ? initialFocus : null,
  );
  const [selected, setSelected] = useState<string | null>(startFocus);
  /** Set by an explicit focus change, so the next URL update adds a history entry. */
  const pushNext = useRef(false);
  // The whole-area camera for the layout's current bounds. React holds the one the steps and
  // the zoom control use; fitRef follows the streaming layout between renders.
  const [fit, setFit] = useState<Camera>(() => fitCamera(boundsOf(null), DEFAULT_VIEW));
  // The settled camera: where the renderer is, or is animating to.
  const [camera, setCameraState] = useState<Camera>(fit);
  const [expanded, setExpanded] = useState<ReadonlySet<NoteKind>>(new Set());

  const fitRef = useRef(fit);
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** True while the area first opens: until the layout first settles the camera follows the
   * spreading notes, unless the viewer takes the camera or changes a setting first (see
   * endOpening). After that only 0, Fit or a resize move it on their own. */
  const opening = useRef(true);
  /** Becomes true once, when the layout first settles; until then the page says it arranges. */
  const [arranged, setArranged] = useState(false);
  /** The bounds the whole-area camera was fitted to, so a resize refits the same box instead of
   * wherever the notes have moved since. */
  const fitBounds = useRef<Bounds>(boundsOf(null));

  /** The part of the stage the open settings box leaves free, from the left edge. Fits and
   * frames use it so what they show is not under the box; when the box would leave less than
   * half the stage, they use the whole stage. */
  const freeView = useCallback((v: Viewport): Viewport => {
    const stage = stageRef.current?.getBoundingClientRect();
    const box = settingsRef.current?.querySelector(".gs-panel")?.getBoundingClientRect();
    const covered = stage && box && box.width > 0 ? stage.right - box.left : 0;
    return covered > 0 && v.width - covered >= v.width / 2
      ? { width: v.width - covered, height: v.height }
      : v;
  }, []);

  /** The pending "wheel gesture ended" sync; a newer programmatic move cancels it. */
  const wheelIdle = useRef<number | undefined>(undefined);

  /** Moves the camera: animated over `ms` (instant under reduced motion), or at once. */
  const moveCamera = useCallback((target: Camera, ms = 0) => {
    window.clearTimeout(wheelIdle.current);
    wheelIdle.current = undefined;
    cameraRef.current = target;
    setCameraState(target);
    const r = rendererRef.current;
    if (!r) return;
    if (ms > 0) void r.animateTo(target, ms);
    else r.setCamera(target);
  }, []);

  /** After a drag or wheel gesture: React learns where the renderer's camera ended up. */
  const syncCamera = useCallback(() => {
    const r = rendererRef.current;
    // An animated move already told React its target; a mid-flight frame would overwrite it.
    if (!r || r.animating) return;
    const c = r.camera;
    cameraRef.current = c;
    setCameraState(c);
  }, []);

  /** Ends the opening the moment the viewer takes the camera (a wheel, a drag, a key, a link)
   * or changes a setting: from then on the camera stays where it is, so a change shows in the
   * notes instead of being undone by a re-fit. */
  const endOpening = useCallback(() => {
    if (!opening.current) return;
    opening.current = false;
    // The stream moved only the renderer; React takes the fit and the camera it left. Without
    // this, a camera taken before the first settle would leave React's fit at the first, tiny
    // spiral of positions for good.
    setFit((f) => (sameCamera(f, fitRef.current) ? f : fitRef.current));
    syncCamera();
  }, [syncCamera]);

  /** The scale that fits the notes where they are now, beside the open settings box. Once
   * forces have spread the notes past the fitted area, zooming out may go this far. */
  const liveFitScale = useCallback(
    () => fitCamera(boundsOf(liveRef.current.current()), freeView(viewRef.current)).s,
    [freeView],
  );

  /** The opening camera: the whole area, with the URL's focus note selected in it. With the
   * card levels on, the closest step on that note instead. */
  const openingCamera = useCallback(
    (f: Camera, v: Viewport): Camera => {
      const p = CARD_LEVELS && startFocus ? posOf(startFocus) : null;
      return stepCamera(p ? 3 : 0, p, f, v);
    },
    [startFocus, posOf],
  );

  // The renderer and the overlay placer live as long as the stage.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const r = new GraphRenderer(canvas, {
      reducedMotion: () => reducedRef.current,
      fitScale: () => fitRef.current.s,
    });
    const placer = new OverlayPlacer(overlay, {
      camera: () => r.camera,
      detailScale: () => fitRef.current.s * STEPS[3],
      growMs: () => (reducedRef.current ? 0 : duration.zoom),
      point: posOf,
    });
    rendererRef.current = r;
    placerRef.current = placer;
    const unsubscribe = r.subscribe((c) => {
      applyDotGrid(stageRef.current, c);
      placer.place();
    });
    r.resize(viewRef.current.width, viewRef.current.height);
    r.setCamera(cameraRef.current);
    return () => {
      unsubscribe();
      placer.destroy();
      r.destroy();
      rendererRef.current = null;
      placerRef.current = null;
    };
  }, [posOf]);

  // Theme changes recolour the canvas, which reads its colours from CSS custom properties.
  useEffect(() => {
    const refresh = () => {
      rendererRef.current?.refreshStyle();
      readColours();
    };
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    mq?.addEventListener?.("change", refresh);
    const mo =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(() => refresh());
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener?.("change", refresh);
      mo?.disconnect();
    };
  }, [readColours]);

  const scene = useMemo(
    () => toScene(visible, visibleEdges, colourOf),
    [visible, visibleEdges, colourOf],
  );
  const sceneRef = useRef<Scene>(EMPTY_SCENE);

  // Lines the layout's positions up with the scene's notes. The mapping is rebuilt only when
  // the scene or the layout's keys change; the buffers are reused between updates.
  const aligned = useRef<{
    scene: Scene | null;
    keys: readonly string[] | null;
    from: Int32Array;
    xs: Float64Array;
    ys: Float64Array;
  }>({
    scene: null,
    keys: null,
    from: new Int32Array(0),
    xs: new Float64Array(0),
    ys: new Float64Array(0),
  });
  const pushPositions = useCallback(() => {
    const r = rendererRef.current;
    const v = liveRef.current.current();
    const sc = sceneRef.current;
    if (!r || !v || sc.nodes.length === 0) return;
    const a = aligned.current;
    if (a.scene !== sc || a.keys !== v.keys) {
      const at = new Map(v.keys.map((k, i) => [k, i]));
      a.scene = sc;
      a.keys = v.keys;
      a.from = Int32Array.from(sc.nodes, (n) => at.get(n.key) ?? -1);
      a.xs = new Float64Array(sc.nodes.length);
      a.ys = new Float64Array(sc.nodes.length);
    }
    alignPositions(a.from, v.xs, v.ys, sc.edges, a.xs, a.ys);
    r.setPositions(a.xs, a.ys);
  }, []);

  /** The whole scene; sceneRef holds what is drawn, which is less during Animate. */
  const fullSceneRef = useRef<Scene>(EMPTY_SCENE);
  /** Cancels the running Animate's next frame. */
  const animation = useRef<(() => void) | null>(null);

  /** Hands the renderer the canvas's names, mapped by key onto `target`, the scene it draws: it
   * reads them against that scene, so they always fit whatever order scenes and regions come in. */
  const pushRegions = useCallback((target: Scene, labels = canvasNamesRef.current) => {
    const r = rendererRef.current;
    if (!r) return;
    if (!labels || target.nodes.length === 0) {
      r.setRegions(null);
      return;
    }
    const assign = Int32Array.from(target.nodes, (n) => labels.at.get(n.key) ?? -1);
    r.setRegions({ assign, names: labels.names });
  }, []);

  const drawScene = useCallback(
    (next: Scene) => {
      sceneRef.current = next;
      rendererRef.current?.setScene(next);
      pushRegions(next);
      pushPositions();
    },
    [pushPositions, pushRegions],
  );

  /** Ends Animate, if it runs, and shows everything. */
  const stopAnimation = useCallback(() => {
    const cancel = animation.current;
    if (!cancel) return;
    animation.current = null;
    cancel();
    drawScene(fullSceneRef.current);
  }, [drawScene]);

  /** Animate, as in Obsidian: notes appear in order of their last update over ANIMATE_MS, on
   * the current positions; partialScene adds each link once both its ends are shown. Under
   * reduced motion the end state, which is already drawn, is all there is. */
  const startAnimation = useCallback(() => {
    stopAnimation();
    const full = fullSceneRef.current;
    if (reducedRef.current || full.nodes.length === 0) return;
    const updated = new Map(visibleRef.current.map((n) => [n.key, n.updatedAt]));
    const ranks = revealRanks(full.nodes.map((n) => updated.get(n.key) ?? ""));
    const start = performance.now();
    let count = -1;
    const tick = () => {
      const t = (performance.now() - start) / ANIMATE_MS;
      if (t >= 1) {
        stopAnimation();
        return;
      }
      const next = Math.min(full.nodes.length, Math.floor(t * full.nodes.length) + 1);
      if (next !== count) {
        count = next;
        drawScene(partialScene(full, ranks, count));
      }
      animation.current = onFrame(tick);
    };
    drawScene(partialScene(full, ranks, 0));
    animation.current = onFrame(tick);
  }, [stopAnimation, drawScene]);
  useEffect(() => () => animation.current?.(), []);

  // A new scene (filters, groups, data) ends Animate and is drawn whole.
  useLayoutEffect(() => {
    fullSceneRef.current = live.ready ? scene : EMPTY_SCENE;
    if (animation.current) stopAnimation();
    else drawScene(fullSceneRef.current);
  }, [scene, live.ready, drawScene, stopAnimation]);

  // New names, or Region labels switched: the renderer hears at once.
  useLayoutEffect(() => {
    pushRegions(sceneRef.current, canvasNames);
  }, [canvasNames, pushRegions]);

  /** Settings changes stop Animate first, as in Obsidian, and end the opening's camera. */
  const changeSettings = useCallback(
    (next: Settings) => {
      stopAnimation();
      endOpening();
      updateSettings(next);
    },
    [stopAnimation, endOpening, updateSettings],
  );
  const restoreSettings = useCallback(() => {
    stopAnimation();
    endOpening();
    resetSettings();
  }, [stopAnimation, endOpening, resetSettings]);

  // The canvas names topics itself, in the same collision-checked placement as region names
  // and note labels, so Topic labels works at every zoom and no label piles on another.
  useLayoutEffect(() => {
    rendererRef.current?.setDisplay({
      nodeSize: display.nodeSize,
      linkThickness: display.linkThickness,
      arrows: display.arrows,
      textFade: display.textFade,
      topicLabels: display.topicLabels,
    });
  }, [
    display.nodeSize,
    display.linkThickness,
    display.arrows,
    display.textFade,
    display.topicLabels,
  ]);

  // Each layout update, outside React: move the dots, then either keep the opening camera on
  // the spreading notes or re-place the overlay where it is. Only the opening follows the
  // notes: later updates (forces, filters, clustering, a drag) leave the camera still.
  useEffect(
    () =>
      live.subscribe(() => {
        pushPositions();
        const r = rendererRef.current;
        if (opening.current && r) {
          const b = boundsOf(liveRef.current.current());
          const f = fitCamera(b, freeView(viewRef.current));
          fitBounds.current = b;
          fitRef.current = f;
          const c = openingCamera(f, viewRef.current);
          cameraRef.current = c;
          r.setCamera(c); // its subscriber re-places the overlay
          return;
        }
        placerRef.current?.place();
      }),
    [live.subscribe, pushPositions, openingCamera, freeView],
  );

  // While the area opens (positions arrive, then settle) React takes each new fit and the
  // camera follows it; the first settle ends the opening, if the viewer has not already. After
  // that only a resize moves the camera here, keeping its place and its zoom relative to the
  // same whole-area box, so dots and labels keep their size; a forces change keeps it, as in
  // Obsidian.
  useLayoutEffect(() => {
    const prevView = viewRef.current;
    viewRef.current = view;
    const r = rendererRef.current;
    r?.resize(view.width, view.height);
    const done = live.ready && live.settled;
    if (done) setArranged(true);
    if (opening.current) {
      const b = boundsOf(live.ready ? liveRef.current.current() : null);
      const next = fitCamera(b, freeView(view));
      fitBounds.current = b;
      fitRef.current = next;
      setFit((f) => (sameCamera(f, next) ? f : next));
      // Always through moveCamera: the stream may have moved the renderer already, but React's
      // copy (which the zoom steps read) only catches up here.
      moveCamera(openingCamera(next, view));
      if (done) opening.current = false;
      return;
    }
    if (prevView.width === view.width && prevView.height === view.height) return;
    const prevFit = fitRef.current;
    const next = fitCamera(fitBounds.current, freeView(view));
    fitRef.current = next;
    setFit((f) => (sameCamera(f, next) ? f : next));
    const c = r?.camera ?? cameraRef.current;
    const centre = toWorld(c, { x: prevView.width / 2, y: prevView.height / 2 });
    moveCamera(centreOn(centre, next.s * (c.s / prevFit.s), view));
  }, [view, live.ready, live.settled, openingCamera, moveCamera, freeView]);

  // Without the card levels the graph is always at the whole-area level, however far it zooms.
  const level: Level = CARD_LEVELS ? levelFor(camera.s, fit.s) : 0;

  // The focus: the selected note, or at the close steps the note nearest the centre of the
  // settled camera (not the mid-animation picture, so it names where the move is going).
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready and settled mark new positions
  const nearest = useMemo(() => {
    const centre = toWorld(camera, { x: view.width / 2, y: view.height / 2 });
    let best: GraphNode | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of visible) {
      if (n.kind === TOPIC_KIND || isTagKey(n.key)) continue;
      const p = posOf(n.key);
      if (!p) continue;
      const d = (p.x - centre.x) ** 2 + (p.y - centre.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }, [camera, view, visible, posOf, live.ready, live.settled]);
  // A selected note that the filters hide is not drawn, so it neither focuses nor inspects.
  // A filter that hides the selected note clears the selection, so clearing the filter
  // does not bring it back unasked. Wait for the data so the URL's focus survives loading.
  useLayoutEffect(() => {
    if (data && selected && !visibleKeys.has(selected)) setSelected(null);
  }, [data, selected, visibleKeys]);
  const shownSelected = selected && visibleKeys.has(selected) ? selected : null;
  const focusKey = shownSelected ?? (level >= 2 ? (nearest?.key ?? null) : null);
  const placed = live.ready && focusKey !== null && posOf(focusKey) !== null;
  const focusNode = focusKey ? (byKey.get(focusKey) ?? null) : null;

  // Emphasis: the selection ring, the hovered note (kept in a ref, set per frame by the pointer)
  // and the depths around a source note, as far as the highlight depth reaches: the hovered
  // note, else the selected one. While nothing is hovered, a group the settings box highlights
  // (lit) wins over the selection, so a group row still shows its notes with a note selected.
  const hoverRef = useRef<string | null>(null);
  const emphasisRef = useRef<{
    focusKey: string | null;
    focusDepths: ReadonlyMap<string, number> | null;
    lit: ReadonlySet<string> | null;
    depth: number;
  }>({ focusKey: null, focusDepths: null, lit: null, depth: 1 });
  const pushEmphasis = useCallback(() => {
    const hovered = hoverRef.current;
    // A note a filter just hid is not drawn, so it lights nothing.
    const hoverKey = hovered !== null && visibleKeysRef.current.has(hovered) ? hovered : null;
    const { focusKey, focusDepths, lit, depth } = emphasisRef.current;
    let depths: ReadonlyMap<string, number> | null = lit ? null : focusDepths;
    if (hoverKey !== null) {
      depths =
        hoverKey === focusKey ? focusDepths : linkDepths(adjacencyRef.current, hoverKey, depth);
    }
    rendererRef.current?.setEmphasis({ focusKey, hoverKey, lit, depths });
  }, []);
  const litKeys = useMemo(() => {
    if (highlight === null || highlight.trim() === "") return null;
    const q = parseQuery(highlight);
    return new Set(visible.filter((n) => matchesQuery(q, targetOf(n))).map((n) => n.key));
  }, [visible, highlight]);
  /** How far each note is from the selected one, for the canvas and the inspector's lists. */
  const focusDepths = useMemo(
    () => (focusKey ? linkDepths(adjacency, focusKey, display.highlightDepth) : null),
    [adjacency, focusKey, display.highlightDepth],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new adjacency re-lights the hover
  useLayoutEffect(() => {
    emphasisRef.current = { focusKey, focusDepths, lit: litKeys, depth: display.highlightDepth };
    pushEmphasis();
  }, [focusKey, focusDepths, litKeys, display.highlightDepth, adjacency, pushEmphasis]);

  const neighbours = useMemo(
    () =>
      focusKey
        ? neighboursWithin(
            data,
            focusKey,
            CARD_HOPS,
            rank,
            (n) => visibleKeys.has(n.node.key) && (filters.suggested || !n.edge.suggested),
          )
        : [],
    [data, focusKey, visibleKeys, filters.suggested, rank],
  );
  // Dormant with the card levels, so no hidden cards sit in the overlay.
  const cards = useMemo(
    () => (CARD_LEVELS ? cardsFor(neighbours, expanded) : []),
    [neighbours, expanded],
  );
  const detailScale = fit.s * STEPS[3];
  const slots = useMemo(() => cardSlots(cards.length, view), [cards.length, view]);
  const places = useMemo(
    (): Array<CardPlace | null> =>
      cards.map((card, i) => {
        const slot = slots[i];
        if (!slot) return null;
        const fromKey =
          card.type === "note" ? card.neighbour.node.key : (card.members[0]?.node.key ?? "");
        return { offset: { x: slot.x / detailScale, y: slot.y / detailScale }, fromKey };
      }),
    [cards, slots, detailScale],
  );

  // Cards mount hidden at their dot, then one styled frame later move to their slots, so
  // every new card grows out of its dot while the camera moves.
  const renderKeys = CARD_LEVELS && focusKey ? [`focus:${focusKey}`, ...cards.map(cardKey)] : [];
  const renderSig = renderKeys.join("|");
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set(renderKeys));
  useLayoutEffect(() => {
    const keys = renderSig ? renderSig.split("|") : [];
    if (keys.every((k) => ready.has(k))) return;
    if (reduced) {
      setReady(new Set(keys));
      return;
    }
    return afterFrame(() => setReady(new Set(keys)));
  }, [renderSig, ready, reduced]);

  const shown = CARD_LEVELS && level >= 2 && placed;

  // After every commit the overlay's points may have changed: place it for the live camera.
  useLayoutEffect(() => {
    placerRef.current?.place();
  });

  const focusStage = useCallback(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  // A card that hides while it has keyboard focus hands focus back to the stage.
  useEffect(() => {
    if (shown) return;
    const active = document.activeElement;
    if (active && overlayRef.current?.contains(active)) focusStage();
  }, [shown, focusStage]);

  // Keep the URL on the selected note, without a hash change that would reload the page.
  // An explicit focus change (a card, the inspector, search) adds a history entry so Back
  // returns to the previous note; camera-only moves replace the current one.
  // Tag nodes are not notes, so the URL keeps no tag.
  useEffect(() => {
    const href = graphHref(domain, selected && byKey.has(selected) ? selected : undefined);
    const push = pushNext.current && window.location.hash !== href;
    pushNext.current = false;
    try {
      if (push) window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    } catch {
      // Some embeddings block history changes; the view still works.
    }
  }, [domain, selected, byKey]);

  // A link from elsewhere (the palette, a note's "Show in graph") moves the camera to its
  // focus, or back to the whole area when it names none. The router's props go stale once
  // replaceState has rewritten the URL, so this reads the hash itself.
  useEffect(() => {
    const onHash = () => {
      const route = parseHash(window.location.hash);
      if (route.name !== "graph" || (route.domain && route.domain !== domain)) return;
      const f = route.focus ?? null;
      if (f === selectedRef.current) return;
      endOpening();
      setExpanded(new Set());
      if (f && byKey.has(f)) {
        setMissing(null);
        setSelected(f);
        const p = posOf(f);
        // Brought to the centre at the current zoom; the card levels zoom into it instead.
        if (CARD_LEVELS)
          moveCamera(stepCamera(3, p, fitRef.current, viewRef.current), duration.zoom);
        else if (p) moveCamera(centreOn(p, cameraRef.current.s, viewRef.current), duration.zoom);
        return;
      }
      setMissing(f);
      setSelected(null);
      if (CARD_LEVELS) moveCamera(fitRef.current, duration.zoom);
    };
    window.addEventListener("hashchange", onHash);
    // Back and Forward between graph entries made with pushState fire popstate.
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [domain, byKey, posOf, moveCamera, endOpening]);

  const goTo = useCallback(
    (target: Level, key: string | null = null) => {
      const k = key ?? focusKey ?? nearest?.key ?? null;
      endOpening();
      if (target === 0) {
        // The whole area as it is now, not as it was when the camera last fitted it.
        const b = boundsOf(liveRef.current.current());
        const f = fitCamera(b, freeView(viewRef.current));
        fitBounds.current = b;
        fitRef.current = f;
        setFit((prev) => (sameCamera(prev, f) ? prev : f));
        moveCamera(f, duration.zoom);
        return;
      }
      if (key) setSelected(key);
      moveCamera(
        stepCamera(target, k ? posOf(k) : null, fitRef.current, viewRef.current),
        duration.zoom,
      );
    },
    [focusKey, nearest, posOf, moveCamera, freeView, endOpening],
  );

  /** Selects a note, as in Obsidian without moving the camera (the card levels zoom to it).
   * From a control that is about to unmount, focus goes to the stage. */
  const focusNote = useCallback(
    (key: string, fromControl = false) => {
      // Only a real change runs the URL effect that clears the flag; a stale flag would
      // turn a later camera-only change into a history entry.
      if (key !== selectedRef.current && byKey.has(key)) pushNext.current = true;
      setExpanded(new Set());
      setMissing(null);
      if (CARD_LEVELS) goTo(level >= 2 ? 3 : 2, key);
      else setSelected(key);
      if (fromControl) focusStage();
    },
    [goTo, level, focusStage, byKey],
  );

  /** Escape: clears the selection (the card levels step out instead). */
  const zoomOut = useCallback(() => {
    if (!CARD_LEVELS) {
      setSelected(null);
      return;
    }
    if (level === 0) {
      setSelected(null);
      return;
    }
    goTo(nextLevel(level, -1));
  }, [goTo, level]);

  /** Frames a region whose name was clicked, beside the settings box while it is open. */
  const zoomToRegion = (region: number) => {
    const bounds = rendererRef.current?.regionBounds(region);
    if (!bounds) return;
    endOpening();
    moveCamera(frameCamera(bounds, freeView(viewRef.current), fitRef.current.s), duration.zoom);
  };

  // A press on a note that moves drags the note, and one on empty canvas pans; a press that
  // doesn't move is a click: on a region's name it frames the region, on a note it selects it.
  const press = useRef<{
    x: number;
    y: number;
    moved: boolean;
    id: number;
    /** The note pressed on: a move drags it. */
    hit: string | null;
    /** The region whose name was pressed on. */
    region: number | null;
    /** The note's centre less the pointer's world point, so the note keeps its place under
     * the pointer instead of jumping to it. */
    grab: Point;
  } | null>(null);
  const localPoint = (e: PointerEvent<HTMLDivElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** True while the pointer is over a region's name, which a click frames. */
  const overRegion = useRef(false);
  /** The stage's cursor: grabbing while a note or the canvas is dragged, a hand over a region's
   * name, grab over a note, and the canvas's own otherwise. */
  const applyCursor = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.cursor = press.current?.moved
      ? "grabbing"
      : overRegion.current
        ? "pointer"
        : hoverRef.current
          ? "grab"
          : "";
  }, []);

  // Hover: at most one pick per frame, however fast the pointer moves.
  const hoverAt = useRef<Point | null>(null);
  const hoverFrame = useRef(0);
  const setHover = useCallback(
    (key: string | null, region = false) => {
      overRegion.current = region;
      if (key !== hoverRef.current) {
        hoverRef.current = key;
        pushEmphasis();
      }
      applyCursor();
    },
    [pushEmphasis, applyCursor],
  );
  /** What is under a stage point. A dot drawn right under it wins over a region's name: names
   * sit on their region's centroid, which is where its hub usually is, so the hub stays within
   * reach. Then the name, then a note within the usual slop around the pointer. */
  const pickAt = useCallback((p: Point): { hit: string | null; region: number | null } => {
    const r = rendererRef.current;
    if (!r) return { hit: null, region: null };
    const dot = r.pick(p.x, p.y, 0);
    if (dot !== null) return { hit: dot, region: null };
    const region = r.pickRegion(p.x, p.y);
    return region === null ? { hit: r.pick(p.x, p.y), region: null } : { hit: null, region };
  }, []);
  /** Hovers what is under a stage point. */
  const hoverPoint = useCallback(
    (p: Point) => {
      const { hit, region } = pickAt(p);
      setHover(hit, region !== null);
    },
    [pickAt, setHover],
  );
  useEffect(
    () => () => {
      if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );
  const scheduleHover = (p: Point) => {
    hoverAt.current = p;
    if (hoverFrame.current || typeof requestAnimationFrame !== "function") return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const at = hoverAt.current;
      if (at) hoverPoint(at);
    });
  };

  // Wheel and trackpad: zoom about the pointer (or pan sideways) on the renderer's camera,
  // with no React update until the gesture ends. React's onWheel is passive, so this
  // listens directly. Zooming out may reach the notes' current spread (liveFitScale), worked
  // out once per gesture, as it measures the stage and the box.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let gestureFit = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnimation();
      const r = rendererRef.current;
      if (!r) return;
      endOpening();
      if (wheelIdle.current === undefined || gestureFit <= 0) gestureFit = liveFitScale();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const c = r.camera;
      const zoom = e.ctrlKey || !e.deltaX || Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const factor = wheelFactor(e.deltaY, e.deltaMode);
      r.setCamera(
        zoom ? zoomAt(c, factor, anchor, fitRef.current.s, gestureFit) : pan(c, -e.deltaX, 0),
      );
      window.clearTimeout(wheelIdle.current);
      wheelIdle.current = window.setTimeout(() => {
        wheelIdle.current = undefined;
        syncCamera();
        // The notes moved under a still pointer, so re-pick what it is over.
        const at = hoverAt.current;
        if (at) hoverPoint(at);
      }, WHEEL_IDLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(wheelIdle.current);
    };
  }, [syncCamera, hoverPoint, stopAnimation, endOpening, liveFitScale]);

  /** Drops the hover, including a pick still queued for the next frame. */
  const clearHover = () => {
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    hoverAt.current = null;
    setHover(null);
  };

  /** Lets go of a note a press dragged, so the graph settles again. */
  const letGo = (d: { moved: boolean; hit: string | null }) => {
    if (!d.moved || !d.hit) return;
    liveRef.current.release(d.hit);
    rendererRef.current?.setDragging(null);
  };

  /** Ends the press of this pointer: a dragged note is let go, so the graph settles again. */
  const endPress = (e: PointerEvent<HTMLDivElement>) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return null;
    press.current = null;
    e.currentTarget.classList.remove("graph-live");
    letGo(d);
    applyCursor();
    return d;
  };
  /** A press that ends without a release: cancelled, its capture lost, or its button let go
   * where the stage never heard it. */
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = endPress(e);
    if (d?.moved && !d.hit) syncCamera();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    stopAnimation();
    // A press another pointer still holds (a second finger, or one whose release never came)
    // gives way, letting go of any note it dragged: a note left held would keep the graph live.
    if (press.current) letGo(press.current);
    const r = rendererRef.current;
    const p = localPoint(e);
    // Pick against the picture on screen, then stop any animated move where it is.
    const { hit, region } = pickAt(p);
    const at = hit ? posOf(hit) : null;
    const world = r ? toWorld(r.camera, p) : p;
    r?.setCamera(r.camera);
    press.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      id: e.pointerId,
      hit,
      region,
      grab: at ? { x: at.x - world.x, y: at.y - world.y } : { x: 0, y: 0 },
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = press.current;
    if (!d) {
      if (e.target === e.currentTarget) scheduleHover(localPoint(e));
      else clearHover(); // over a card, no dot is under the pointer
      return;
    }
    if (d.id !== e.pointerId) return;
    // No button is down during a real press, for mouse, touch or pen alike: the release came
    // where the stage never heard it (a context menu, another window). End the press, or every
    // plain move would go on dragging and keep the graph live.
    if (e.buttons === 0) {
      onPointerCancel(e);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    const r = rendererRef.current;
    if (!r) return;
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.classList.add("graph-live");
      // From the first move the camera is the viewer's: the opening ends, so no refit moves
      // the camera, and a dragged note with it, away from the pointer.
      endOpening();
      if (d.hit) r.setDragging(d.hit);
      applyCursor();
    }
    if (d.hit) {
      // The note is held at the pointer and the graph follows it (layout.ts).
      const w = toWorld(r.camera, localPoint(e));
      liveRef.current.drag(d.hit, w.x + d.grab.x, w.y + d.grab.y);
      return;
    }
    d.x = e.clientX;
    d.y = e.clientY;
    r.setCamera(pan(r.camera, dx, dy));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = endPress(e);
    if (!d) return;
    if (d.moved) {
      if (!d.hit) syncCamera();
      return;
    }
    // A click on a region's name frames the region, a click on a note selects it, and a click
    // on empty canvas clears the selection.
    if (d.region !== null) zoomToRegion(d.region);
    else if (d.hit) focusNote(d.hit);
    else setSelected(null);
  };

  const keyMove = (key: string): (() => void) | null => {
    const centre = { x: view.width / 2, y: view.height / 2 };
    // Start from where the camera is going: an animation's target (cameraRef), else the
    // renderer's camera, which is ahead of React's copy during a wheel gesture.
    const from = () => {
      const r = rendererRef.current;
      return !r || r.animating ? cameraRef.current : r.camera;
    };
    const panBy = (dx: number, dy: number) => () => moveCamera(pan(from(), dx, dy), duration.view);
    // The same limits as the wheel: fitRef is right even before React has caught up with it.
    const zoomBy = (factor: number) => () =>
      moveCamera(zoomAt(from(), factor, centre, fitRef.current.s, liveFitScale()), duration.zoom);
    switch (key) {
      case "ArrowLeft":
        return panBy(PAN_STEP, 0);
      case "ArrowRight":
        return panBy(-PAN_STEP, 0);
      case "ArrowUp":
        return panBy(0, PAN_STEP);
      case "ArrowDown":
        return panBy(0, -PAN_STEP);
      case "+":
      case "=":
        return zoomBy(1.25);
      case "-":
        return zoomBy(0.8);
      case "0":
        return () => goTo(0);
      case "Enter": {
        // The note the focus and its cards show; nearest skips topic rings.
        const near = focusKey ?? nearest?.key ?? null;
        return near ? () => focusNote(near) : null;
      }
      default:
        return null;
    }
  };

  const onStageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== stageRef.current || e.key === "Escape") return;
    const move = keyMove(e.key);
    if (!move) return;
    e.preventDefault();
    endOpening();
    move();
  };

  // Any key ends Animate. Esc clears the selection from anywhere on the page, except where a field has text to clear.
  const onPageKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    stopAnimation();
    if (e.key === "[" && hasCommandKey(e) && !e.defaultPrevented) {
      // ⌘[ goes back to the previous note, as in the board.
      e.preventDefault();
      window.history.back();
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      target.value !== ""
    ) {
      return;
    }
    e.preventDefault();
    zoomOut();
  };

  // Development only: ?perf=1 runs the performance probe once, after the layout first settles
  // (a drag or a forces change settles again, and must not set it off a second time).
  const [perf] = useState(wantsPerfProbe);
  const mountedAt = useRef(performance.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, not per scene change
  useEffect(() => {
    if (!import.meta.env.DEV || !perf || !arranged) return;
    const layoutMs = performance.now() - mountedAt.current;
    const r = rendererRef.current;
    if (!r) return;
    let cancelled = false;
    const b = boundsOf(liveRef.current.current());
    const centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    void import("./perfProbe").then(async ({ runPerfProbe }) => {
      if (cancelled) return;
      await runPerfProbe({
        renderer: r,
        nodes: scene.nodes.length,
        edges: scene.edges.length,
        layoutMs,
        whole: fitRef.current,
        close: stepCamera(3, centre, fitRef.current, viewRef.current),
        durationMs: duration.zoom,
      });
      if (!cancelled) syncCamera();
    });
    return () => {
      cancelled = true;
    };
  }, [perf, arranged]);

  // The caption describes what is drawn, so it follows the filters.
  const noteCount = visible.filter((n) => !isTagKey(n.key)).length;
  const tagCount = visible.length - noteCount;
  const linkCount = visibleEdges.length;
  const hidden = data.nodes.length - noteCount;
  const focusLabel = focusNode?.key ?? "a note";
  const recorded = neighbours.filter((n) => !n.edge.suggested).length;
  const suggested = neighbours.length - recorded;
  // The canvas is hidden from screen readers, so the caption says what it names and where
  // the list of those names is.
  const namedCount = namedParts.length;
  const namedNoun = groupsNamed
    ? namedCount === 1
      ? "colour group"
      : "colour groups"
    : namedCount === 1
      ? "brain region"
      : "brain regions";
  // While names show on the canvas, the hint says a click on one zooms to its part.
  const nameHint = canvasNames
    ? groupsNamed
      ? " Click a group's name to zoom to it."
      : " Click a region's name to zoom to it."
    : "";
  const caption = [
    `${formatCount(noteCount)}${hidden > 0 ? ` of ${formatCount(data.nodes.length)}` : ""} notes${tagCount > 0 ? `, ${formatCount(tagCount)} tags` : ""} and ${formatCount(linkCount)} links in ${areaLabel}`,
    namedCount > 0
      ? `${formatCount(namedCount)} named ${namedNoun}, listed in graph settings under Display`
      : "",
    focusNode
      ? `Selected ${focusLabel}: ${formatCount(recorded)} recorded links${suggested ? ` and ${formatCount(suggested)} suggested by reflect` : ""}`
      : "",
  ]
    .filter((part) => part !== "")
    .join(". ");

  // Screen readers hear only settled states. Camera state only changes once a gesture ends,
  // so a short delay is enough to skip the steps of a quick series of moves.
  const [announced, setAnnounced] = useState(caption);
  useEffect(() => {
    const t = window.setTimeout(() => setAnnounced(caption), 300);
    return () => window.clearTimeout(t);
  }, [caption]);

  const inspected = shownSelected ? (byKey.get(shownSelected) ?? null) : null;

  const onOpenCard = useStableCallback((key: string) => focusNote(key, true));
  const onExpandGroup = useStableCallback((kind: NoteKind) => {
    setExpanded((prev) => new Set([...prev, kind]));
    focusStage();
  });

  const closeSettings = () => {
    setHighlight(null);
    setPanel({ ...panel, open: false });
    // Escape, Close or the gear hands focus to the gear, which opens the box again.
    settingsRef.current?.querySelector<HTMLButtonElement>(".graph-settings-button")?.focus();
  };

  const stageEmpty =
    data.nodes.length === 0 ? (
      <EmptyState title="No notes in this area yet">
        Notes show here once something is saved to {areaLabel}.
      </EmptyState>
    ) : visible.length === 0 ? (
      <EmptyState title="No notes match the filters">
        Change the filters in graph settings to see notes.
      </EmptyState>
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc bubbles up from the page's controls
    <div className="graph-main" onKeyDown={onPageKeyDown}>
      <h1 id="graph-title" className="graph-sr">
        Graph
      </h1>
      <p id="graph-caption" className="graph-sr">
        {caption}
      </p>
      <p className="graph-sr" aria-live="polite">
        {announced}
      </p>
      <div className={`graph-body${panel.open ? " graph-body-settings" : ""}`}>
        <div
          ref={stageRef}
          className="graph-stage"
          role="application"
          aria-label={`Graph of ${areaLabel}. Arrow keys move, plus and minus zoom, 0 fits the area, Enter selects the note nearest the centre, Escape clears the selection.`}
          aria-describedby="graph-caption graph-stage-hint"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes arrow keys, + and −
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onPointerLeave={clearHover}
          onKeyDown={onStageKeyDown}
        >
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the canvas has no tabindex; the stage and the overlay carry its meaning */}
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            aria-hidden="true"
            style={{ opacity: BG_OPACITY[level] }}
          />
          <Overlay
            rootRef={overlayRef}
            focusNode={CARD_LEVELS && placed ? focusNode : null}
            cards={cards}
            places={places}
            ready={ready}
            shown={shown}
            labelsOn={level === 3}
            lit={litKeys}
            colourOf={colourOf}
            onOpen={onOpenCard}
            onExpand={onExpandGroup}
          />
          {stageEmpty && <div className="graph-stage-empty">{stageEmpty}</div>}
          {/* Only the first arrangement: later ones (a drag, a force) show in the notes moving. */}
          {!arranged && visible.length > 0 && (
            <p className="graph-status" role="status">
              Arranging notes
            </p>
          )}
          {missing && (
            <p className="graph-status graph-notice" role="status">
              <span className="k-mono">{missing}</span> isn't in {areaLabel}. Showing the whole
              area.
            </p>
          )}
          <p id="graph-stage-hint" className="graph-hint">
            {level < 2
              ? `Scroll to zoom and drag to move. Drag a note to pull it, or click it to select it.${nameHint}`
              : "Esc or − zooms out. Click a card to move to that note."}
          </p>
        </div>
        {inspected && (
          <div className="graph-float graph-float-inspector">
            <Inspector
              node={inspected}
              data={data}
              visibleKeys={visibleKeys}
              rank={rank}
              colourOf={colourOf}
              depths={focusDepths}
              onFocus={(key) => {
                focusNote(key, true);
                // A neighbour off screen would be selected with nothing to show for it, so
                // centre it; on-screen notes stay put, as in Obsidian.
                const p = posOf(key);
                if (!p) return;
                const at = toScreen(cameraRef.current, p);
                const v = viewRef.current;
                if (at.x < 0 || at.y < 0 || at.x > v.width || at.y > v.height) {
                  endOpening();
                  moveCamera(centreOn(p, cameraRef.current.s, v), duration.zoom);
                }
              }}
              onAround={() => {
                // Brings the note to the centre, one step closer (the card levels go further).
                if (CARD_LEVELS) {
                  goTo(3, inspected.key);
                  return;
                }
                endOpening();
                moveCamera(
                  stepCamera(1, posOf(inspected.key), fitRef.current, viewRef.current),
                  duration.zoom,
                );
              }}
              onClose={() => {
                setSelected(null);
                focusStage();
              }}
            />
            {neighbours.length === 0 && level >= 2 && (
              <p className="k-legend-note">{focusLabel} has no links shown with these filters.</p>
            )}
          </div>
        )}
        {areaButton && <div className="graph-float graph-float-area">{areaButton}</div>}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: catches Escape from the gear and the panel */}
        <div
          ref={settingsRef}
          className="graph-float graph-float-settings"
          onKeyDown={(e) => {
            // Escape closes the panel even while focus is still on the gear.
            if (e.key !== "Escape" || !panel.open) return;
            e.preventDefault();
            e.stopPropagation();
            closeSettings();
          }}
        >
          <div className="graph-tools">
            <IconButton
              icon="fit"
              label="Fit the whole area"
              className="graph-tool"
              onClick={() => goTo(0)}
            />
            {/* A toggle: pressed while the box is open, and closing it hands focus back here. */}
            <IconButton
              icon="settings"
              label="Graph settings"
              className="graph-tool graph-settings-button"
              aria-expanded={panel.open}
              onClick={() => (panel.open ? closeSettings() : setPanel({ ...panel, open: true }))}
            />
            {/* As in Obsidian, the wand under the gear plays Animate; the open box has its own. */}
            {!panel.open && (
              <IconButton
                icon="wand"
                label="Animate"
                className="graph-tool graph-tool-animate"
                onClick={startAnimation}
              />
            )}
          </div>
          {panel.open && (
            <GraphSettings
              settings={settings}
              onChange={changeSettings}
              onReset={restoreSettings}
              onAnimate={startAnimation}
              panel={panel}
              onPanelChange={setPanel}
              onHighlight={setHighlight}
              onClose={closeSettings}
              named={namedParts}
              onZoomTo={zoomToRegion}
            />
          )}
        </div>
      </div>
    </div>
  );
}
