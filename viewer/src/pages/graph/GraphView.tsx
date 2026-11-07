// The stage: a canvas the GraphRenderer draws every note and link on, under an HTML overlay
// (labels and the focused neighbourhood's cards). The renderer owns the live camera: drag and
// wheel move it directly and React hears about it once a gesture ends, so a pan or zoom never
// re-renders the page per event. Buttons, keys and clicks animate it with animateTo; reduced
// motion makes those moves instant. The overlay follows the camera through renderer.subscribe.
//
// As in Obsidian, the layout is a live simulation (useLiveLayout) and the settings float behind
// a button at the top right. Positions stream outside React: each update moves the dots in
// place (renderer.setPositions) and re-places the overlay, which follows notes by key.
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type GraphData,
  type GraphNode,
  kindCounts,
  kindLabel,
  type NoteKind,
  TOPIC_KIND,
} from "../../api";
import { hasCommandKey } from "../../app/overlay";
import { graphHref, parseHash } from "../../app/router";
import { EmptyState, IconButton, SearchField, SegmentedControl, Switch } from "../../components/ui";
import { duration, usePrefersReducedMotion } from "../../motion";
import {
  type Camera,
  centreOn,
  dotGrid,
  fitCamera,
  type Level,
  levelFor,
  nextLevel,
  pan,
  STEPS,
  stepCamera,
  toWorld,
  type Viewport,
  wheelFactor,
  zoomAt,
} from "./camera";
import { GraphSettings } from "./GraphSettings";
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
  findNodes,
  formatCount,
  neighboursWithin,
  rankFrom,
} from "./model";
import { type CardPlace, Overlay } from "./Overlay";
import { OverlayPlacer } from "./placer";
import { groupColour, matchesQuery, parseQuery, type QueryTarget } from "./query";
import { GraphRenderer } from "./renderer";
import type { Scene } from "./scene";
import { useGraphSettings, usePanelState } from "./settings";
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

const targetOf = (n: GraphNode): QueryTarget => ({ key: n.key, title: n.title, kind: n.kind });

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

/** A note's key short enough for the zoom control: its last path segment. graph.css cuts it
 * off with an ellipsis if it is still too long; the caption above shows the whole key. */
function shortKey(key: string | undefined): string {
  if (!key) return "Note";
  return key.slice(key.lastIndexOf("/") + 1) || key;
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

const LEVEL_NAMES = ["Whole area", "Closer", "Neighbourhood"] as const;
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

  // The canvas needs a concrete colour, so --type-other is read from the page (and again on a
  // theme change, below).
  const [otherColour, setOtherColour] = useState(OTHER_FALLBACK);
  const readOther = useCallback(() => {
    const el = stageRef.current;
    let value = "";
    try {
      value = el ? getComputedStyle(el).getPropertyValue("--type-other").trim() : "";
    } catch {
      value = "";
    }
    setOtherColour(value || OTHER_FALLBACK);
  }, []);
  useLayoutEffect(readOther, [readOther]);

  const groups = useMemo(
    () => settings.groups.map((g) => ({ query: parseQuery(g.query), color: g.color })),
    [settings.groups],
  );
  const colours = useMemo(
    () => new Map(data.nodes.map((n) => [n.key, groupColour(groups, targetOf(n)) ?? otherColour])),
    [data, groups, otherColour],
  );
  const colourOf = useCallback(
    (n: GraphNode) => colours.get(n.key) ?? otherColour,
    [colours, otherColour],
  );

  // Filters, as in Obsidian: the search query, legacy notes, suggested links and orphans.
  const filterQuery = useMemo(() => parseQuery(filters.query), [filters.query]);
  const visibleData = useMemo((): GraphData => {
    const matching = data.nodes.filter(
      (n) => (filters.legacy || n.status !== "legacy") && matchesQuery(filterQuery, targetOf(n)),
    );
    const keys = new Set(matching.map((n) => n.key));
    const edges = data.edges.filter(
      (e) => keys.has(e.source) && keys.has(e.target) && (filters.suggested || !e.suggested),
    );
    if (filters.orphans) return { nodes: matching, edges };
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    return { nodes: matching.filter((n) => linked.has(n.key)), edges };
  }, [data, filterQuery, filters.legacy, filters.suggested, filters.orphans]);
  const visible = visibleData.nodes;
  const visibleEdges = visibleData.edges;
  const visibleKeys = useMemo(() => new Set(visible.map((n) => n.key)), [visible]);

  const live = useLiveLayout(domain, visibleData, settings.forces);
  const liveRef = useRef(live);
  liveRef.current = live;
  const arranging = !live.settled;

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
  const [hops, setHops] = useState<1 | 2>(1);
  const hopsLabelId = useId();
  /** Set by an explicit focus change, so the next URL update adds a history entry. */
  const pushNext = useRef(false);
  // The whole-area camera for the layout's current bounds. React holds the one the steps and
  // the zoom control use; fitRef follows the streaming layout between renders.
  const [fit, setFit] = useState<Camera>(() => fitCamera(boundsOf(null), DEFAULT_VIEW));
  // The settled camera: where the renderer is, or is animating to.
  const [camera, setCameraState] = useState<Camera>(fit);
  const [expanded, setExpanded] = useState<ReadonlySet<NoteKind>>(new Set());
  const [query, setQuery] = useState("");

  const fitRef = useRef(fit);
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** True once the viewer moved the camera: from then on the layout never moves it. */
  const userMoved = useRef(false);

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

  /** The opening camera: on the URL's focus note at the closest step, else the whole area. */
  const openingCamera = useCallback(
    (f: Camera, v: Viewport): Camera => {
      const p = startFocus ? posOf(startFocus) : null;
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
      readOther();
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
  }, [readOther]);

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

  useLayoutEffect(() => {
    const next = live.ready ? scene : EMPTY_SCENE;
    sceneRef.current = next;
    rendererRef.current?.setScene(next);
    pushPositions();
  }, [scene, live.ready, pushPositions]);

  useLayoutEffect(() => {
    rendererRef.current?.setDisplay({
      nodeSize: display.nodeSize,
      linkThickness: display.linkThickness,
      arrows: display.arrows,
      textFade: display.textFade,
    });
  }, [display.nodeSize, display.linkThickness, display.arrows, display.textFade]);

  // Each layout update, outside React: move the dots, then either keep the opening camera on
  // the spreading notes (until the viewer moves it) or re-place the overlay where it is.
  useEffect(
    () =>
      live.subscribe(() => {
        pushPositions();
        const r = rendererRef.current;
        if (!userMoved.current && r) {
          const f = fitCamera(boundsOf(liveRef.current.current()), viewRef.current);
          fitRef.current = f;
          const c = openingCamera(f, viewRef.current);
          cameraRef.current = c;
          r.setCamera(c); // its subscriber re-places the overlay
          return;
        }
        placerRef.current?.place();
      }),
    [live.subscribe, pushPositions, openingCamera],
  );

  // When the layout first has positions, settles, or the stage resizes: React takes the new
  // fit. The opening camera follows it until the viewer moves; after that a resize keeps the
  // camera's place and a forces change keeps the camera, as in Obsidian.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settled marks the final positions
  useLayoutEffect(() => {
    const prevView = viewRef.current;
    viewRef.current = view;
    const r = rendererRef.current;
    r?.resize(view.width, view.height);
    const prevFit = fitRef.current;
    const next = fitCamera(boundsOf(live.ready ? liveRef.current.current() : null), view);
    fitRef.current = next;
    setFit((f) => (sameCamera(f, next) ? f : next));
    if (!userMoved.current) {
      // Always through moveCamera: the stream may have moved the renderer already, but React's
      // copy (which the zoom steps read) only catches up here.
      moveCamera(openingCamera(next, view));
      return;
    }
    if (prevView.width === view.width && prevView.height === view.height) return;
    const c = r?.camera ?? cameraRef.current;
    const centre = toWorld(c, { x: prevView.width / 2, y: prevView.height / 2 });
    moveCamera(centreOn(centre, next.s * (c.s / prevFit.s), view));
  }, [view, live.ready, live.settled, openingCamera, moveCamera]);

  const level = levelFor(camera.s, fit.s);

  // The focus: the selected note, or at the close steps the note nearest the centre of the
  // settled camera (not the mid-animation picture, so it names where the move is going).
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready and settled mark new positions
  const nearest = useMemo(() => {
    const centre = toWorld(camera, { x: view.width / 2, y: view.height / 2 });
    let best: GraphNode | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of visible) {
      if (n.kind === TOPIC_KIND) continue;
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
  const shownSelected = selected && visibleKeys.has(selected) ? selected : null;
  const focusKey = shownSelected ?? (level >= 2 ? (nearest?.key ?? null) : null);
  const placed = live.ready && focusKey !== null && posOf(focusKey) !== null;
  const focusNode = focusKey ? (byKey.get(focusKey) ?? null) : null;

  // Emphasis: the focus ring, the hovered note (kept in a ref, set per frame by the pointer)
  // and the notes a hovered settings group matches.
  const hoverRef = useRef<string | null>(null);
  const emphasisRef = useRef<{ focusKey: string | null; lit: ReadonlySet<string> | null }>({
    focusKey: null,
    lit: null,
  });
  const pushEmphasis = useCallback(() => {
    rendererRef.current?.setEmphasis({ ...emphasisRef.current, hoverKey: hoverRef.current });
  }, []);
  const litKeys = useMemo(() => {
    if (highlight === null || highlight.trim() === "") return null;
    const q = parseQuery(highlight);
    return new Set(visible.filter((n) => matchesQuery(q, targetOf(n))).map((n) => n.key));
  }, [visible, highlight]);
  useLayoutEffect(() => {
    emphasisRef.current = { focusKey, lit: litKeys };
    pushEmphasis();
  }, [focusKey, litKeys, pushEmphasis]);

  const neighbours = useMemo(
    () =>
      focusKey
        ? neighboursWithin(
            data,
            focusKey,
            hops,
            rank,
            (n) => visibleKeys.has(n.node.key) && (filters.suggested || !n.edge.suggested),
          )
        : [],
    [data, focusKey, visibleKeys, filters.suggested, hops, rank],
  );
  const cards = useMemo(() => cardsFor(neighbours, expanded), [neighbours, expanded]);
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
  const renderKeys = focusKey ? [`focus:${focusKey}`, ...cards.map(cardKey)] : [];
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

  const shown = level >= 2 && placed;

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
  useEffect(() => {
    const href = graphHref(domain, selected ?? undefined);
    const push = pushNext.current && window.location.hash !== href;
    pushNext.current = false;
    try {
      if (push) window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    } catch {
      // Some embeddings block history changes; the view still works.
    }
  }, [domain, selected]);

  // A link from elsewhere (the palette, a note's "Show in graph") moves the camera to its
  // focus, or back to the whole area when it names none. The router's props go stale once
  // replaceState has rewritten the URL, so this reads the hash itself.
  useEffect(() => {
    const onHash = () => {
      const route = parseHash(window.location.hash);
      if (route.name !== "graph" || (route.domain && route.domain !== domain)) return;
      const f = route.focus ?? null;
      if (f === selectedRef.current) return;
      userMoved.current = true;
      setExpanded(new Set());
      if (f && byKey.has(f)) {
        setMissing(null);
        setSelected(f);
        moveCamera(stepCamera(3, posOf(f), fitRef.current, viewRef.current), duration.zoom);
        return;
      }
      setMissing(f);
      setSelected(null);
      moveCamera(fitRef.current, duration.zoom);
    };
    window.addEventListener("hashchange", onHash);
    // Back and Forward between graph entries made with pushState fire popstate.
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [domain, byKey, posOf, moveCamera]);

  const goTo = useCallback(
    (target: Level, key: string | null = null) => {
      const k = key ?? focusKey ?? nearest?.key ?? null;
      userMoved.current = true;
      if (target === 0) {
        // The whole area as it is now, not as it was when the layout last settled.
        const f = fitCamera(boundsOf(liveRef.current.current()), viewRef.current);
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
    [focusKey, nearest, posOf, moveCamera],
  );

  /** Moves to a note. From a control that is about to unmount, focus goes to the stage. */
  const focusNote = useCallback(
    (key: string, fromControl = false) => {
      // Only a real change runs the URL effect that clears the flag; a stale flag would
      // turn a later camera-only change into a history entry.
      if (key !== selectedRef.current) pushNext.current = true;
      setExpanded(new Set());
      setMissing(null);
      goTo(level >= 2 ? 3 : 2, key);
      if (fromControl) focusStage();
    },
    [goTo, level, focusStage],
  );

  const zoomOut = useCallback(() => {
    if (level === 0) {
      setSelected(null);
      return;
    }
    goTo(nextLevel(level, -1));
  }, [goTo, level]);

  // Drag to move; a press that doesn't move is a click on the note under it.
  const drag = useRef<{
    x: number;
    y: number;
    moved: boolean;
    id: number;
    hit: string | null;
  } | null>(null);
  const localPoint = (e: PointerEvent<HTMLDivElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Hover: at most one pick per frame, however fast the pointer moves.
  const hoverAt = useRef<Point | null>(null);
  const hoverFrame = useRef(0);
  const setHover = useCallback(
    (key: string | null) => {
      if (key === hoverRef.current) return;
      hoverRef.current = key;
      if (stageRef.current) stageRef.current.style.cursor = key ? "pointer" : "";
      pushEmphasis();
    },
    [pushEmphasis],
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
      if (!at) return;
      setHover(rendererRef.current?.pick(at.x, at.y) ?? null);
    });
  };

  // Wheel and trackpad: zoom about the pointer (or pan sideways) on the renderer's camera,
  // with no React update until the gesture ends. React's onWheel is passive, so this
  // listens directly.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rendererRef.current;
      if (!r) return;
      userMoved.current = true;
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const c = r.camera;
      const zoom = e.ctrlKey || !e.deltaX || Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      r.setCamera(
        zoom
          ? zoomAt(c, wheelFactor(e.deltaY, e.deltaMode), anchor, fitRef.current.s)
          : pan(c, -e.deltaX, 0),
      );
      window.clearTimeout(wheelIdle.current);
      wheelIdle.current = window.setTimeout(() => {
        wheelIdle.current = undefined;
        syncCamera();
        // The notes moved under a still pointer, so re-pick what it is over.
        const at = hoverAt.current;
        if (at) setHover(rendererRef.current?.pick(at.x, at.y) ?? null);
      }, WHEEL_IDLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(wheelIdle.current);
    };
  }, [syncCamera, setHover]);

  /** Drops the hover, including a pick still queued for the next frame. */
  const clearHover = () => {
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    hoverAt.current = null;
    setHover(null);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const r = rendererRef.current;
    const p = localPoint(e);
    // Pick against the picture on screen, then stop any animated move where it is.
    const hit = r?.pick(p.x, p.y) ?? null;
    r?.setCamera(r.camera);
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, hit };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) {
      if (e.target === e.currentTarget) scheduleHover(localPoint(e));
      else clearHover(); // over a card, no dot is under the pointer
      return;
    }
    if (d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    const r = rendererRef.current;
    if (!r) return;
    if (!d.moved) e.currentTarget.classList.add("graph-live");
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    userMoved.current = true;
    r.setCamera(pan(r.camera, dx, dy));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.classList.remove("graph-live");
    return d && d.id === e.pointerId ? d : null;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = endDrag(e);
    if (!d) return;
    if (!d.moved && d.hit) {
      focusNote(d.hit);
      return;
    }
    syncCamera();
  };
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (endDrag(e)) syncCamera();
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
    const zoomBy = (factor: number) => () =>
      moveCamera(zoomAt(from(), factor, centre, fit.s), duration.zoom);
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
    userMoved.current = true;
    move();
  };

  // Esc zooms out from anywhere on the page, except where a field has text to clear.
  const onPageKeyDown = (e: KeyboardEvent<HTMLElement>) => {
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

  // Development only: ?perf=1 runs the performance probe once the layout settles.
  const [perf] = useState(wantsPerfProbe);
  const mountedAt = useRef(performance.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per settle, not per scene change
  useEffect(() => {
    if (!import.meta.env.DEV || !perf || arranging) return;
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
  }, [perf, arranging]);

  // The caption describes what is drawn, so it follows the filters.
  const linkCount = visibleEdges.length;
  const hidden = data.nodes.length - visible.length;
  const focusLabel = focusNode?.key ?? "a note";
  const recorded = neighbours.filter((n) => !n.edge.suggested).length;
  const suggested = neighbours.length - recorded;
  const caption = [
    `Whole area: ${formatCount(visible.length)}${hidden > 0 ? ` of ${formatCount(data.nodes.length)}` : ""} notes and ${formatCount(linkCount)} links in ${areaLabel}`,
    `Closer: the notes around ${focusLabel} come forward`,
    `Neighbourhood: ${focusLabel} and the ${formatCount(neighbours.length)} notes it links to`,
    `Around ${focusLabel}: ${formatCount(recorded)} recorded links${suggested ? ` and ${formatCount(suggested)} suggested by reflect` : ""}`,
  ][level];

  // Screen readers hear only settled states. Camera state only changes once a gesture ends,
  // so a short delay is enough to skip the steps of a quick series of moves.
  const [announced, setAnnounced] = useState(caption);
  useEffect(() => {
    const t = window.setTimeout(() => setAnnounced(caption), 300);
    return () => window.clearTimeout(t);
  }, [caption]);

  const stepOptions = [
    ...LEVEL_NAMES.map((label, i) => ({ value: String(i), label })),
    { value: "3", label: shortKey(focusNode?.key ?? nearest?.key) },
  ];
  const matches = useMemo(() => findNodes(visible, query), [visible, query]);
  const inspected = shownSelected ? (byKey.get(shownSelected) ?? null) : null;

  const topics = useMemo(
    () =>
      display.topicLabels
        ? visible.flatMap((n) => (n.kind === TOPIC_KIND ? [{ key: n.key, title: n.title }] : []))
        : [],
    [display.topicLabels, visible],
  );
  const onOpenCard = useStableCallback((key: string) => focusNote(key, true));
  const onExpandGroup = useStableCallback((kind: NoteKind) => {
    setExpanded((prev) => new Set([...prev, kind]));
    focusStage();
  });

  const closeSettings = () => {
    setHighlight(null);
    setPanel({ ...panel, open: false });
    // Escape or Close hands focus back to the button that opened the panel.
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
      <header className="graph-head">
        <div className="graph-head-text">
          <h1 id="graph-title">Graph</h1>
          <p className="k-count">{caption}</p>
          <p className="graph-sr" aria-live="polite">
            {announced}
          </p>
          {missing && (
            <p className="k-legend-note" role="status">
              <span className="k-mono">{missing}</span> isn't in {areaLabel}. Showing the whole
              area.
            </p>
          )}
        </div>
        <div className="graph-find">
          <SearchField
            label="Find a note in the graph"
            placeholder="Find a note"
            value={query}
            onChange={setQuery}
          />
          {matches.length > 0 && (
            <ul className="graph-matches" aria-label="Matching notes">
              {matches.map((n) => (
                <li key={n.key}>
                  <button
                    type="button"
                    className="graph-match"
                    onClick={() => {
                      setQuery("");
                      focusNote(n.key, true);
                    }}
                  >
                    <svg className="k-swatch" viewBox="0 0 12 12" aria-hidden="true">
                      <circle cx="6" cy="6" r="5" style={{ fill: colourOf(n) }} />
                    </svg>
                    <span className="k-mono">{n.key}</span>
                    <span className="graph-match-title">{n.title}</span>
                    <span className="k-meta">{kindLabel(n.kind)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="graph-steps">
          <SegmentedControl
            label="Zoom"
            hideLabel
            options={stepOptions}
            value={String(level)}
            onChange={(v) => goTo(Number(v) as Level)}
          />
          <IconButton
            icon="minus"
            label="Zoom out"
            disabled={level === 0 && !selected}
            onClick={zoomOut}
          />
          <IconButton
            icon="plus"
            label="Zoom in"
            disabled={level === 3}
            onClick={() => goTo(nextLevel(level, 1))}
          />
          <span className="graph-hops">
            <span id={hopsLabelId}>2 hops</span>
            <Switch
              small
              checked={hops === 2}
              onChange={(on) => setHops(on ? 2 : 1)}
              labelledBy={hopsLabelId}
            />
          </span>
        </div>
        {areaButton}
      </header>
      <div className="graph-body">
        <div
          ref={stageRef}
          className="graph-stage"
          role="application"
          aria-label={`Graph of ${areaLabel}. Arrow keys move, plus and minus zoom, Enter opens the note nearest the centre, Escape zooms out.`}
          aria-describedby="graph-stage-hint"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes arrow keys, + and −
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
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
            topics={topics}
            topicsOn={level < 2}
            focusNode={placed ? focusNode : null}
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
          {arranging && visible.length > 0 && (
            <p className="graph-status" role="status">
              Arranging notes
            </p>
          )}
          <p id="graph-stage-hint" className="graph-hint">
            {level < 2
              ? "Scroll to zoom and drag to move. Click a note to see it with its links."
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
              onFocus={(key) => focusNote(key, true)}
              onAround={() => goTo(3, inspected.key)}
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
          <IconButton
            icon="settings"
            label="Graph settings"
            className="graph-settings-button"
            aria-expanded={panel.open}
            onClick={() => setPanel({ ...panel, open: !panel.open })}
          />
          {panel.open && (
            <GraphSettings
              settings={settings}
              onChange={updateSettings}
              onReset={resetSettings}
              panel={panel}
              onPanelChange={setPanel}
              onHighlight={setHighlight}
              onClose={closeSettings}
            />
          )}
        </div>
      </div>
    </div>
  );
}
