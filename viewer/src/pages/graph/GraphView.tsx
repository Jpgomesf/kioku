// The stage: a canvas the GraphRenderer draws every note and link on, under an HTML overlay
// (labels and the focused neighbourhood's cards). The renderer owns the live camera: drag and
// wheel move it directly and React hears about it once a gesture ends, so a pan or zoom never
// re-renders the page per event. Buttons, keys and clicks animate it with animateTo; reduced
// motion makes those moves instant. The overlay follows the camera through renderer.subscribe.
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
import { type GraphData, type GraphNode, kindLabel, type NoteKind, TOPIC_KIND } from "../../api";
import { hasCommandKey } from "../../app/overlay";
import { graphHref, parseHash } from "../../app/router";
import { EmptyState, IconButton, SearchField, SegmentedControl, Switch } from "../../components/ui";
import { duration, usePrefersReducedMotion } from "../../motion";
import {
  type Camera,
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
import { colourFor, useColourSlots } from "./colours";
import { Inspector } from "./Inspector";
import { Legend } from "./Legend";
import { type Layout, type Point, useLayout, WORLD } from "./layout";
import {
  cardKey,
  cardSlots,
  cardsFor,
  DEFAULT_FILTERS,
  type Filters,
  findNodes,
  formatCount,
  isVisible,
  neighboursWithin,
} from "./model";
import { Overlay } from "./Overlay";
import { OverlayPlacer } from "./placer";
import { GraphRenderer } from "./renderer";
import { toScene } from "./toScene";

export interface GraphViewProps {
  domain: string;
  areaLabel: string;
  data: GraphData;
  initialFocus: string | undefined;
  areaButton: ReactNode;
}

const DEFAULT_VIEW: Viewport = { width: 1000, height: 640 };

/** Shown until the layout worker sends its first positions. */
const EMPTY_LAYOUT: Layout = {
  positions: new Map(),
  bounds: { minX: 0, minY: 0, maxX: WORLD.width, maxY: WORLD.height },
};

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
  const rendererRef = useRef<GraphRenderer | null>(null);
  const placerRef = useRef<OverlayPlacer | null>(null);
  const view = useViewport(stageRef);
  const reduced = usePrefersReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const { layout: liveLayout, settling } = useLayout(domain, data);
  const layout = liveLayout ?? EMPTY_LAYOUT;
  const arranging = settling || liveLayout === null;
  const byKey = useMemo(() => new Map(data.nodes.map((n) => [n.key, n])), [data]);
  const fit = useMemo(() => fitCamera(layout.bounds, view), [layout, view]);

  const posOf = useCallback(
    (key: string): Point | null => layout.positions.get(key) ?? null,
    [layout],
  );

  const startFocus = initialFocus && byKey.has(initialFocus) ? initialFocus : null;
  const [missing, setMissing] = useState<string | null>(
    initialFocus && !startFocus ? initialFocus : null,
  );
  const [selected, setSelected] = useState<string | null>(startFocus);
  const [hops, setHops] = useState<1 | 2>(1);
  const hopsLabelId = useId();
  /** Set by an explicit focus change, so the next URL update adds a history entry. */
  const pushNext = useRef(false);
  // The settled camera: where the renderer is, or is animating to. Opens already zoomed.
  const [camera, setCameraState] = useState<Camera>(() => {
    const p = startFocus ? posOf(startFocus) : null;
    return stepCamera(p ? 3 : 0, p, fit, view);
  });
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [colourSlots, assignSlot] = useColourSlots(domain);
  const [highlightKind, setHighlightKind] = useState<NoteKind | null>(null);
  // A hidden type has no notes on screen, so highlighting it would only fade everything.
  const litKind =
    highlightKind !== null && !filters.hidden.has(highlightKind) ? highlightKind : null;
  const [expanded, setExpanded] = useState<ReadonlySet<NoteKind>>(new Set());
  const [query, setQuery] = useState("");

  const fitRef = useRef(fit);
  fitRef.current = fit;
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** True once the viewer moved the camera, so a settling layout stops refitting it. */
  const userMoved = useRef(false);
  const detailScaleRef = useRef(fit.s * STEPS[3]);
  detailScaleRef.current = fit.s * STEPS[3];

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
      detailScale: () => detailScaleRef.current,
      growMs: () => (reducedRef.current ? 0 : duration.zoom),
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
  }, []);

  // Theme changes recolour the canvas, which reads its colours from CSS custom properties.
  useEffect(() => {
    const refresh = () => rendererRef.current?.refreshStyle();
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
  }, []);

  // Keep the camera's place across resizes.
  useLayoutEffect(() => {
    const prevView = viewRef.current;
    viewRef.current = view;
    const r = rendererRef.current;
    r?.resize(view.width, view.height);
    if (prevView.width === view.width && prevView.height === view.height) return;
    const c = r?.camera ?? cameraRef.current;
    const centre = toWorld(c, { x: prevView.width / 2, y: prevView.height / 2 });
    const before = fitCamera(layout.bounds, prevView);
    const s = fit.s * (c.s / before.s);
    moveCamera({ x: view.width / 2 - centre.x * s, y: view.height / 2 - centre.y * s, s });
  }, [view, fit, layout, moveCamera]);

  // While the layout settles, keep the opening camera on it until the viewer moves. Once they
  // picked a note, keep that note centred at the current step as the notes move under it.
  useLayoutEffect(() => {
    if (userMoved.current) {
      const sel = selectedRef.current;
      const p = sel ? (layout.positions.get(sel) ?? null) : null;
      if (p) {
        const atLevel = levelFor(cameraRef.current.s, fit.s);
        moveCamera(stepCamera(atLevel, p, fit, viewRef.current));
      }
      return;
    }
    const p = startFocus ? (layout.positions.get(startFocus) ?? null) : null;
    moveCamera(stepCamera(p ? 3 : 0, p, fit, viewRef.current));
  }, [layout, fit, startFocus, moveCamera]);

  const level = levelFor(camera.s, fit.s);

  // Keyed on the fields isVisible reads, so toggling topic labels doesn't rebuild the scene.
  const { hidden, legacy } = filters;
  const visible = useMemo(
    () => data.nodes.filter((n) => isVisible(n, { hidden, legacy })),
    [data, hidden, legacy],
  );
  const visibleKeys = useMemo(() => new Set(visible.map((n) => n.key)), [visible]);
  const visibleEdges = useMemo(
    () =>
      data.edges.filter(
        (e) =>
          visibleKeys.has(e.source) &&
          visibleKeys.has(e.target) &&
          (filters.suggested || !e.suggested),
      ),
    [data, visibleKeys, filters.suggested],
  );

  const scene = useMemo(
    () => toScene(visible, visibleEdges, layout.positions, colourSlots),
    [visible, visibleEdges, layout, colourSlots],
  );
  useLayoutEffect(() => {
    rendererRef.current?.setScene(scene);
  }, [scene]);

  // The focus: the selected note, or at the close steps the note nearest the centre of the
  // settled camera (not the mid-animation picture, so it names where the move is going).
  const nearest = useMemo(() => {
    const centre = toWorld(camera, { x: view.width / 2, y: view.height / 2 });
    let best: GraphNode | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of visible) {
      if (n.kind === TOPIC_KIND) continue;
      const p = layout.positions.get(n.key);
      if (!p) continue;
      const d = (p.x - centre.x) ** 2 + (p.y - centre.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }, [camera, view, visible, layout]);
  // A selected note that the filters hide is not drawn, so it neither focuses nor inspects.
  const shownSelected = selected && visibleKeys.has(selected) ? selected : null;
  const focusKey = shownSelected ?? (level >= 2 ? (nearest?.key ?? null) : null);
  const focusNode = focusKey ? (byKey.get(focusKey) ?? null) : null;
  const focusPos = focusKey ? posOf(focusKey) : null;

  // Emphasis: the focus ring, the hovered note (kept in a ref, set per frame by the pointer)
  // and the legend's highlighted type.
  const hoverRef = useRef<string | null>(null);
  const emphasisRef = useRef<{ focusKey: string | null; lit: ReadonlySet<string> | null }>({
    focusKey: null,
    lit: null,
  });
  const pushEmphasis = useCallback(() => {
    rendererRef.current?.setEmphasis({ ...emphasisRef.current, hoverKey: hoverRef.current });
  }, []);
  const litKeys = useMemo(
    () =>
      litKind === null
        ? null
        : new Set(visible.filter((n) => n.kind === litKind).map((n) => n.key)),
    [visible, litKind],
  );
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
            colourSlots,
            (n) => visibleKeys.has(n.node.key) && (filters.suggested || !n.edge.suggested),
          )
        : [],
    [data, focusKey, visibleKeys, filters.suggested, hops, colourSlots],
  );
  const cards = useMemo(() => cardsFor(neighbours, expanded), [neighbours, expanded]);
  const detailScale = fit.s * STEPS[3];
  const slots = useMemo(() => cardSlots(cards.length, view), [cards.length, view]);
  const places = useMemo(
    () =>
      cards.map((card, i) => {
        const slot = slots[i];
        if (!focusPos || !slot) return null;
        const dotKey =
          card.type === "note" ? card.neighbour.node.key : (card.members[0]?.node.key ?? "");
        return {
          slot: { x: focusPos.x + slot.x / detailScale, y: focusPos.y + slot.y / detailScale },
          from: layout.positions.get(dotKey) ?? focusPos,
        };
      }),
    [cards, slots, focusPos, detailScale, layout],
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

  const shown = level >= 2 && focusPos !== null;

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
        moveCamera(fitRef.current, duration.zoom);
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
    const centre = {
      x: (layout.bounds.minX + layout.bounds.maxX) / 2,
      y: (layout.bounds.minY + layout.bounds.maxY) / 2,
    };
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

  const linkCount = data.edges.length;
  const focusLabel = focusNode?.key ?? "a note";
  const recorded = neighbours.filter((n) => !n.edge.suggested).length;
  const suggested = neighbours.length - recorded;
  const caption = [
    `Whole area: ${formatCount(data.nodes.length)} notes and ${formatCount(linkCount)} links in ${areaLabel}`,
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
      filters.topicLabels
        ? visible.flatMap((n) => {
            const at = n.kind === TOPIC_KIND ? layout.positions.get(n.key) : undefined;
            return at ? [{ key: n.key, title: n.title, at }] : [];
          })
        : [],
    [filters.topicLabels, visible, layout],
  );
  const onOpenCard = useStableCallback((key: string) => focusNote(key, true));
  const onExpandGroup = useStableCallback((kind: NoteKind) => {
    setExpanded((prev) => new Set([...prev, kind]));
    focusStage();
  });

  const stageEmpty =
    data.nodes.length === 0 ? (
      <EmptyState title="No notes in this area yet">
        Notes show here once something is saved to {areaLabel}.
      </EmptyState>
    ) : visible.length === 0 ? (
      <EmptyState title="Every note type is off">
        Turn a note type on under Note types to see it.
      </EmptyState>
    ) : null;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc bubbles up from the page's controls */}
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
            focusNode={focusNode}
            focusPos={focusPos}
            cards={cards}
            places={places}
            ready={ready}
            shown={shown}
            labelsOn={level === 3}
            litKind={litKind}
            slots={colourSlots}
            onOpen={onOpenCard}
            onExpand={onExpandGroup}
          />
          {stageEmpty && <div className="graph-stage-empty">{stageEmpty}</div>}
          {arranging && data.nodes.length > 0 && (
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
      </div>
      <aside className="graph-side" aria-label="Graph details" onKeyDown={onPageKeyDown}>
        <div className="graph-find">
          <SearchField label="Find a note in the graph" value={query} onChange={setQuery} />
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
                      <circle
                        cx="6"
                        cy="6"
                        r="5"
                        style={{ fill: colourFor(colourSlots, n.kind) }}
                      />
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
        {inspected ? (
          <Inspector
            node={inspected}
            data={data}
            visibleKeys={visibleKeys}
            slots={colourSlots}
            onFocus={(key) => focusNote(key, true)}
            onAround={() => goTo(3, inspected.key)}
            onClose={() => {
              setSelected(null);
              focusStage();
            }}
          />
        ) : null}
        <Legend
          data={data}
          filters={filters}
          onChange={setFilters}
          slots={colourSlots}
          onAssign={assignSlot}
          onHighlight={setHighlightKind}
        />
        {neighbours.length === 0 && level >= 2 && focusNode && (
          <p className="k-legend-note">{focusLabel} has no links shown with these types.</p>
        )}
      </aside>
    </>
  );
}
