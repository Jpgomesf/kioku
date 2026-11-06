// The stage: one camera over an SVG layer (dots, edges, topic rings) and an HTML layer
// (labels and the focused neighbourhood's cards). Both layers sit in world space under the
// same camera transform, so CSS animates them together. Buttons and clicks animate the
// camera; the wheel, trackpad and drag move it live. Reduced motion makes it instant.
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
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
  type GraphEdge,
  type GraphNode,
  kindLabel,
  kindNoun,
  type NoteKind,
  TOPIC_KIND,
} from "../../api";
import { hasCommandKey } from "../../app/overlay";
import { graphHref, noteHref, parseHash } from "../../app/router";
import { EmptyState, IconButton, SearchField, SegmentedControl, Switch } from "../../components/ui";
import { usePrefersReducedMotion } from "../../motion";
import {
  type Camera,
  cameraTransform,
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
import { type ColourSlots, colourFor, slotOf, useColourSlots } from "./colours";
import { Inspector } from "./Inspector";
import { Legend } from "./Legend";
import { layoutFor, type Point } from "./layout";
import {
  type Card,
  cardKey,
  cardSlots,
  cardsFor,
  DEFAULT_FILTERS,
  dotRadius,
  type Filters,
  findNodes,
  formatCount,
  isVisible,
  neighboursWithin,
} from "./model";

export interface GraphViewProps {
  domain: string;
  areaLabel: string;
  data: GraphData;
  initialFocus: string | undefined;
  areaButton: ReactNode;
}

const DEFAULT_VIEW: Viewport = { width: 1000, height: 640 };

function useViewport(ref: React.RefObject<HTMLDivElement | null>): Viewport {
  const [view, setView] = useState<Viewport>(DEFAULT_VIEW);
  // Measured before paint, so the first frame already uses the real size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setView({ width: r.width, height: r.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return view;
}

/** The canvas dot grid's size and offset, as custom properties graph.css reads. */
function dotStyle(camera: Camera): CSSProperties {
  const { gap, x, y } = dotGrid(camera);
  return { "--dot-gap": `${gap}px`, "--dot-x": `${x}px`, "--dot-y": `${y}px` } as CSSProperties;
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

const LEVEL_NAMES = ["Whole area", "Closer", "Neighbourhood"] as const;
const BG_OPACITY = [1, 1, 0.5, 0.2] as const;

export function GraphView({ domain, areaLabel, data, initialFocus, areaButton }: GraphViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraElRef = useRef<SVGGElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const view = useViewport(stageRef);
  const reduced = usePrefersReducedMotion();
  const layout = useMemo(() => layoutFor(domain, data), [domain, data]);
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
  // Opens already zoomed: the first commit carries the focus camera.
  const [camera, setCamera] = useState<Camera>(() => {
    const p = startFocus ? posOf(startFocus) : null;
    return stepCamera(p ? 3 : 0, p, fit, view);
  });
  const [animate, setAnimate] = useState(false);
  const [live, setLive] = useState(false);
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
  cameraRef.current = camera;
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Keep the camera's place across resizes.
  useLayoutEffect(() => {
    const prevView = viewRef.current;
    viewRef.current = view;
    if (prevView.width === view.width && prevView.height === view.height) return;
    setAnimate(false);
    const c = cameraRef.current;
    const centre = toWorld(c, { x: prevView.width / 2, y: prevView.height / 2 });
    const before = fitCamera(layout.bounds, prevView);
    const s = fit.s * (c.s / before.s);
    setCamera({ x: view.width / 2 - centre.x * s, y: view.height / 2 - centre.y * s, s });
  }, [view, fit, layout]);

  const level = levelFor(camera.s, fit.s);

  const visible = useMemo(() => data.nodes.filter((n) => isVisible(n, filters)), [data, filters]);
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

  // The focus: the selected note, or at the close steps the note nearest the centre.
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
  const slotWorld = (i: number): Point | null => {
    const slot = slots[i];
    if (!focusPos || !slot) return null;
    return { x: focusPos.x + slot.x / detailScale, y: focusPos.y + slot.y / detailScale };
  };

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
  const isShown = (key: string) => shown && ready.has(key);

  const focusStage = useCallback(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  // A card that hides while it has keyboard focus hands focus back to the stage.
  useEffect(() => {
    if (shown) return;
    const active = document.activeElement;
    if (active && worldRef.current?.contains(active)) focusStage();
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
      setAnimate(true);
      setLive(false);
      setExpanded(new Set());
      if (f && byKey.has(f)) {
        setMissing(null);
        setSelected(f);
        setCamera(stepCamera(3, posOf(f), fitRef.current, viewRef.current));
        return;
      }
      setMissing(f);
      setSelected(null);
      setCamera(fitRef.current);
    };
    window.addEventListener("hashchange", onHash);
    // Back and Forward between graph entries made with pushState fire popstate.
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [domain, byKey, posOf]);

  const goTo = useCallback(
    (target: Level, key: string | null = null) => {
      const k = key ?? focusKey ?? nearest?.key ?? null;
      setAnimate(true);
      setLive(false);
      if (target === 0) {
        setCamera(fitRef.current);
        return;
      }
      if (key) setSelected(key);
      setCamera(stepCamera(target, k ? posOf(k) : null, fitRef.current, viewRef.current));
    },
    [focusKey, nearest, posOf],
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

  /** The camera as drawn right now, mid-animation included. */
  const liveCamera = useCallback((): Camera => {
    const c = cameraRef.current;
    const el = cameraElRef.current;
    if (!animateRef.current || !el || typeof DOMMatrix === "undefined") return c;
    try {
      const t = window.getComputedStyle(el).transform;
      if (!t || t === "none") return c;
      const m = new DOMMatrix(t);
      return m.a > 0 ? { x: m.e, y: m.f, s: m.a } : c;
    } catch {
      return c;
    }
  }, []);

  /** Stops an animated move where it is, so a live move continues from the picture. */
  const interrupt = useCallback(() => {
    if (!animateRef.current) return;
    const c = liveCamera();
    cameraRef.current = c;
    animateRef.current = false;
    setCamera(c);
    setAnimate(false);
  }, [liveCamera]);

  // Wheel and trackpad: live zoom about the pointer, merged into one update per frame.
  // React's onWheel is passive, so this listens directly.
  const idle = useRef<number | undefined>(undefined);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let pending: { factor: number; anchor: Point; dx: number } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      setCamera((c) => {
        const panned = p.dx ? pan(c, p.dx, 0) : c;
        return p.factor === 1 ? panned : zoomAt(panned, p.factor, p.anchor, fitRef.current.s);
      });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      interrupt();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setAnimate(false);
      setLive(true);
      const p = pending ?? { factor: 1, anchor, dx: 0 };
      p.anchor = anchor;
      if (e.ctrlKey || !e.deltaX || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        p.factor *= wheelFactor(e.deltaY, e.deltaMode);
      } else {
        p.dx -= e.deltaX;
      }
      pending = p;
      if (typeof window.requestAnimationFrame === "function") {
        if (!frame) frame = window.requestAnimationFrame(flush);
      } else {
        flush();
      }
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => setLive(false), 160);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(idle.current);
    };
  }, [interrupt]);

  const hitTest = (screen: Point): GraphNode | null => {
    const c = liveCamera();
    const w = toWorld(c, screen);
    let best: GraphNode | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of visible) {
      const p = layout.positions.get(n.key);
      if (!p) continue;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      const reach = Math.max(dotRadius(n), 10 / c.s);
      if (d <= reach && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  // Drag to move; a press that doesn't move is a click on the nearest dot.
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number; hit: Point } | null>(
    null,
  );
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Hit-test against the picture on screen before stopping the move.
    const found = animateRef.current ? hitTest(hit) : null;
    interrupt();
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, hit };
    pressHit.current = found;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const pressHit = useRef<GraphNode | null>(null);
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setAnimate(false);
    setLive(true);
    setCamera((c) => pan(c, dx, dy));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    setLive(false);
    if (d.moved) return;
    const hit = pressHit.current ?? hitTest(d.hit);
    pressHit.current = null;
    if (hit) focusNote(hit.key);
  };

  const keyMove = (key: string, step: number, centre: Point): (() => void) | null => {
    switch (key) {
      case "ArrowLeft":
        return () => setCamera((c) => pan(c, step, 0));
      case "ArrowRight":
        return () => setCamera((c) => pan(c, -step, 0));
      case "ArrowUp":
        return () => setCamera((c) => pan(c, 0, step));
      case "ArrowDown":
        return () => setCamera((c) => pan(c, 0, -step));
      case "+":
      case "=":
        return () => setCamera((c) => zoomAt(c, 1.25, centre, fit.s));
      case "-":
        return () => setCamera((c) => zoomAt(c, 0.8, centre, fit.s));
      case "0":
        return () => goTo(0);
      case "Enter":
        return nearest ? () => focusNote(nearest.key) : null;
      default:
        return null;
    }
  };

  const onStageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== stageRef.current || e.key === "Escape") return;
    const centre = { x: view.width / 2, y: view.height / 2 };
    const move = keyMove(e.key, 48, centre);
    if (!move) return;
    e.preventDefault();
    if (e.key !== "0" && e.key !== "Enter") setAnimate(!reduced);
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

  const transition = animate && !live && !reduced ? "graph-animate" : "";

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

  // Screen readers hear only settled states, not every frame of a live move.
  const [announced, setAnnounced] = useState(caption);
  useEffect(() => {
    if (live) return;
    const t = window.setTimeout(() => setAnnounced(caption), 300);
    return () => window.clearTimeout(t);
  }, [caption, live]);

  const stepOptions = [
    ...LEVEL_NAMES.map((label, i) => ({ value: String(i), label })),
    { value: "3", label: focusNode?.key ?? nearest?.key ?? "Note" },
  ];
  const matches = useMemo(() => findNodes(visible, query), [visible, query]);
  const inspected = shownSelected ? (byKey.get(shownSelected) ?? null) : null;
  const highlight = level < 2 ? shownSelected : null;

  // World-space placement for the HTML layer; `k` keeps a constant on-screen size.
  const at = (p: Point, k: number, anchor = "-50%, -50%"): CSSProperties => ({
    transform: `translate(${p.x}px, ${p.y}px) translate(${anchor}) scale(${k})`,
  });
  const label = 1 / camera.s;
  const cardK = 1 / detailScale;

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
          className={`graph-stage ${transition}${live ? " graph-live" : ""}`}
          style={dotStyle(camera)}
          role="application"
          aria-label={`Graph of ${areaLabel}. Arrow keys move, plus and minus zoom, Enter opens the note nearest the centre, Escape zooms out.`}
          aria-describedby="graph-stage-hint"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes arrow keys, + and −
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setLive(false);
          }}
          onKeyDown={onStageKeyDown}
        >
          <svg className="graph-svg" width={view.width} height={view.height} aria-hidden="true">
            <g
              ref={cameraElRef}
              className="graph-camera"
              style={{ transform: cameraTransform(camera) }}
            >
              <Background
                edges={visibleEdges}
                nodes={visible}
                positions={layout.positions}
                focusKey={focusKey}
                highlight={highlight}
                highlightKind={litKind}
                slots={colourSlots}
                opacity={BG_OPACITY[level]}
              />
              {focusPos && (
                <g className="graph-focus-edges" style={{ opacity: shown ? 1 : 0 }}>
                  {cards.map((card, i) => {
                    const p = slotWorld(i);
                    if (!p) return null;
                    const edgeClass =
                      card.type !== "note"
                        ? ""
                        : card.neighbour.edge.suggested
                          ? " graph-edge-suggested"
                          : card.neighbour.node.status === "legacy"
                            ? " graph-edge-legacy"
                            : "";
                    const fade = litKind !== null && cardKind(card) !== litKind ? " graph-dim" : "";
                    return (
                      <line
                        key={cardKey(card)}
                        className={`graph-edge-strong${edgeClass}${fade}`}
                        x1={focusPos.x}
                        y1={focusPos.y}
                        x2={p.x}
                        y2={p.y}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </g>
              )}
            </g>
          </svg>

          <div
            ref={worldRef}
            className="graph-html graph-world"
            style={{ transform: cameraTransform(camera) }}
          >
            {filters.topicLabels &&
              visible
                .filter((n) => n.kind === TOPIC_KIND)
                .map((n) => {
                  const p = layout.positions.get(n.key);
                  if (!p) return null;
                  return (
                    <span
                      key={n.key}
                      className="graph-topic-label"
                      aria-hidden="true"
                      style={{
                        ...at({ x: p.x, y: p.y + dotRadius(n) + 6 * label }, label, "-50%, 0"),
                        opacity: level < 2 ? 1 : 0,
                      }}
                    >
                      {n.title}
                    </span>
                  );
                })}
            {focusNode && focusPos && (
              <span
                className="graph-dot-label"
                aria-hidden="true"
                style={{
                  ...at({ x: focusPos.x, y: focusPos.y + 10 * label }, label, "-50%, 0"),
                  opacity: shown ? 0 : 1,
                }}
              >
                {focusNode.key}
              </span>
            )}
            {focusPos &&
              cards.map((card, i) => {
                const p = slotWorld(i);
                if (!p || card.type !== "note") return null;
                const mid = { x: (focusPos.x + p.x) / 2, y: (focusPos.y + p.y) / 2 };
                const e = card.neighbour.edge;
                const on = isShown(cardKey(card)) && level === 3;
                return (
                  <span
                    key={`label:${cardKey(card)}`}
                    className={`graph-edge-label${e.suggested ? " graph-edge-label-suggested" : ""}`}
                    aria-hidden={!on}
                    style={{ ...at(mid, cardK), opacity: on ? 1 : 0 }}
                  >
                    {e.relation}
                    {e.suggested ? " · not recorded" : ""}
                  </span>
                );
              })}
            {focusNode &&
              focusPos &&
              (() => {
                const on = isShown(`focus:${focusNode.key}`);
                return (
                  <a
                    key={focusNode.key}
                    className="k-node graph-card graph-card-focus"
                    href={noteHref(focusNode.domain, focusNode.key)}
                    tabIndex={on ? 0 : -1}
                    inert={!on}
                    style={{
                      ...at(focusPos, on ? cardK : cardK * 0.05),
                      opacity: on ? 1 : 0,
                      pointerEvents: on ? "auto" : "none",
                    }}
                  >
                    <span className="k-node-kind">
                      <span>
                        <span className="k-mono">{focusNode.key}</span> ·{" "}
                        {kindLabel(focusNode.kind)}
                      </span>
                    </span>
                    <span className="k-node-title">{focusNode.title}</span>
                  </a>
                );
              })()}
            {focusPos &&
              cards.map((card, i) => {
                const slot = slotWorld(i);
                if (!slot) return null;
                const from =
                  card.type === "note"
                    ? posOf(card.neighbour.node.key)
                    : posOf(card.members[0]?.node.key ?? "");
                const on = isShown(cardKey(card));
                const dim = litKind !== null && cardKind(card) !== litKind;
                const style: CSSProperties = {
                  ...at(on ? slot : (from ?? focusPos), on ? cardK : cardK * 0.05),
                  opacity: on ? (dim ? CARD_DIM : 1) : 0,
                  pointerEvents: on ? "auto" : "none",
                };
                return (
                  <CardButton
                    key={cardKey(card)}
                    card={card}
                    slots={colourSlots}
                    dim={dim}
                    style={style}
                    shown={on}
                    onOpen={(key) => focusNote(key, true)}
                    onExpand={(kind) => {
                      setExpanded((prev) => new Set([...prev, kind]));
                      focusStage();
                    }}
                  />
                );
              })}
          </div>
          {stageEmpty && <div className="graph-stage-empty">{stageEmpty}</div>}
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

interface BackgroundProps {
  edges: GraphEdge[];
  nodes: GraphNode[];
  positions: ReadonlyMap<string, Point>;
  focusKey: string | null;
  /** The selected note whose links stand out at the far steps. */
  highlight: string | null;
  /** The type hovered or focused in the legend: its notes stay bright, the rest dim. */
  highlightKind: NoteKind | null;
  slots: ColourSlots;
  opacity: number;
}

/** Every edge and dot. Memoised so a camera move only changes the camera transform. */
const Background = memo(function Background({
  edges,
  nodes,
  positions,
  focusKey,
  highlight,
  highlightKind,
  slots,
  opacity,
}: BackgroundProps) {
  const kindOf = useMemo(() => new Map(nodes.map((n) => [n.key, n.kind])), [nodes]);
  const dimmed = (key: string) => highlightKind !== null && kindOf.get(key) !== highlightKind;
  const focusAt = focusKey ? positions.get(focusKey) : undefined;
  const focusNode = focusKey ? nodes.find((n) => n.key === focusKey) : undefined;
  return (
    <g className="graph-bg" style={{ opacity }}>
      {edges.map((e) => {
        const a = positions.get(e.source);
        const b = positions.get(e.target);
        if (!a || !b) return null;
        const touches = highlight !== null && (e.source === highlight || e.target === highlight);
        const base = e.suggested
          ? "graph-edge graph-edge-suggested"
          : touches
            ? "graph-edge graph-edge-selected"
            : "graph-edge";
        const cls = dimmed(e.source) && dimmed(e.target) ? `${base} graph-dim` : base;
        return (
          <line
            key={`${e.source}>${e.target}>${e.relation}`}
            className={cls}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {nodes.map((n) => (
        <Dot
          key={n.key}
          node={n}
          at={positions.get(n.key)}
          colour={colourFor(slots, n.kind)}
          slot={slotOf(slots, n.kind)}
          dim={dimmed(n.key)}
        />
      ))}
      {focusAt && focusNode && (
        <circle
          className="graph-dot-ring"
          cx={focusAt.x}
          cy={focusAt.y}
          r={dotRadius(focusNode) + 2.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
});

function Dot({
  node,
  at,
  colour,
  slot,
  dim,
}: {
  node: GraphNode;
  at: Point | undefined;
  colour: string;
  /** The colour slot index, or -1 for grey. */
  slot: number;
  dim: boolean;
}) {
  if (!at) return null;
  const r = dotRadius(node);
  const fade = dim ? " graph-dim" : "";
  if (node.kind === TOPIC_KIND) {
    return (
      <circle
        className={`graph-ring${fade}`}
        cx={at.x}
        cy={at.y}
        r={r}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  return (
    <circle
      className={`graph-dot${node.status === "legacy" ? " graph-dot-legacy" : ""}${
        slot === 1 ? " graph-dot-2" : slot === 2 ? " graph-dot-3" : ""
      }${fade}`}
      cx={at.x}
      cy={at.y}
      r={r}
      style={{ fill: colour }}
      vectorEffect="non-scaling-stroke"
    />
  );
}

interface CardButtonProps {
  card: Card;
  slots: ColourSlots;
  style: CSSProperties;
  shown: boolean;
  /** Another type is highlighted in the legend. */
  dim: boolean;
  onOpen: (key: string) => void;
  onExpand: (kind: NoteKind) => void;
}

/** A card of another type than the one highlighted in the legend. */
const CARD_DIM = 0.35;

/** The type a card stands for: its note's, or its group's. */
function cardKind(card: Card): NoteKind {
  return card.type === "group" ? card.kind : card.neighbour.node.kind;
}

function CardButton({ card, slots, style, shown, dim, onOpen, onExpand }: CardButtonProps) {
  const hidden = { tabIndex: shown ? 0 : -1, "aria-hidden": !shown, inert: !shown };
  const fade = dim ? " graph-dim" : "";
  if (card.type === "group") {
    const n = card.members.length;
    return (
      <button
        type="button"
        className={`k-node graph-card graph-card-group${fade}`}
        style={style}
        {...hidden}
        onClick={() => onExpand(card.kind)}
      >
        <span className="k-node-kind">
          <span>
            <span className="graph-kind-dot" style={{ background: colourFor(slots, card.kind) }} />
            {formatCount(n)} more {kindNoun(card.kind, n)}
          </span>
        </span>
        <span className="k-node-title">Open the group</span>
      </button>
    );
  }
  const { node, edge } = card.neighbour;
  const legacy = node.status === "legacy";
  const cls = [
    "k-node",
    "graph-card",
    edge.suggested ? "k-node-flagged" : "",
    legacy ? "graph-card-legacy" : "",
    dim ? "graph-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={cls}
      style={style}
      {...hidden}
      onClick={() => onOpen(node.key)}
    >
      <span className="k-node-kind">
        <span>
          <span className="graph-kind-dot" style={{ background: colourFor(slots, node.kind) }} />
          <span className="k-mono">{node.key}</span> · {kindLabel(node.kind)}
        </span>
        {legacy && <span>superseded</span>}
        {edge.suggested && <span className="k-node-flag">suggested</span>}
      </span>
      <span className="k-node-title">{node.title}</span>
    </button>
  );
}
