// The selected note: what it is, every link it has (recorded or suggested by reflect) and, when
// the highlight depth reaches further, how many notes the graph lights 2 or 3 links away, the
// first few of them listed. The header and the actions stay in view while the links scroll under
// them, so Open the note is in reach however many links a note has; a fade and a "Scroll for N
// more" hint show while rows are still below.
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type GraphData, type GraphNode, kindLabel } from "../../api";
import { noteHref } from "../../app/router";
import { Button, FindingCallout, Icon, IconButton, StatusPill } from "../../components/ui";
import { prefersReducedMotion } from "../../motion";
import { formatCount, type KindRank, neighboursOf, sentence } from "./model";
import "./inspector.css";

export interface InspectorProps {
  node: GraphNode;
  data: GraphData;
  /** Notes the filters leave on the canvas; links to any other note are left out. */
  visibleKeys: ReadonlySet<string>;
  rank: KindRank;
  colourOf: (node: GraphNode) => string;
  /**
   * How many links away from this note each note the graph lights with it is (0 for this note),
   * as far as the highlight depth reaches. Notes 2 or more links away are listed after the note's
   * own links, the first few of each level; without it, or with depths counted from another note
   * (a hovered one), only the note's own links are.
   */
  depths?: ReadonlyMap<string, number> | null;
  onFocus: (key: string) => void;
  onAround: () => void;
  onClose: () => void;
}

/**
 * Rows listed per farther level. Two or three links from a well-linked note reach most of a large
 * area (1,500 of 2,000 notes in a 16,000-link one), and as rows they would be thousands of Tab
 * stops that say little; the heading keeps the whole count and the graph lights them all.
 */
const FARTHER_ROWS = 25;

/** The notes the same number of links away from the selected one. */
interface Farther {
  depth: number;
  /** The first FARTHER_ROWS of them at most, in the order the note's own links come in. */
  nodes: GraphNode[];
  total: number;
}

/** "1 direct link", "1,204 direct links". */
function count(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** The graph's type order, then by title: the order the note's own links come in. */
function byTypeThenTitle(rank: KindRank): (a: GraphNode, b: GraphNode) => number {
  return (a, b) =>
    rank(a.kind) - rank(b.kind) ||
    (a.kind === b.kind ? 0 : kindLabel(a.kind).localeCompare(kindLabel(b.kind))) ||
    a.title.localeCompare(b.title) ||
    a.key.localeCompare(b.key);
}

/** The notes 2 or more links away, nearest first, each level with its count and its first
 * FARTHER_ROWS notes. Tags are not notes, so they get no row, and a note already listed as a link
 * keeps that row only. */
function fartherNotes(
  depths: ReadonlyMap<string, number>,
  byKey: ReadonlyMap<string, GraphNode>,
  listed: ReadonlySet<string>,
  visibleKeys: ReadonlySet<string>,
  rank: KindRank,
): Farther[] {
  const byDepth = new Map<number, GraphNode[]>();
  for (const [key, depth] of depths) {
    if (depth < 2 || listed.has(key) || !visibleKeys.has(key)) continue;
    const node = byKey.get(key);
    if (!node) continue;
    const nodes = byDepth.get(depth);
    if (nodes) nodes.push(node);
    else byDepth.set(depth, [node]);
  }
  return [...byDepth]
    .sort(([a], [b]) => a - b)
    .map(([depth, nodes]) => ({
      depth,
      nodes: nodes.sort(byTypeThenTitle(rank)).slice(0, FARTHER_ROWS),
      total: nodes.length,
    }));
}

/** How many rows end below the list's visible part. Rows run top to bottom, so a binary search
 * finds the first hidden one in a few reads, however long the list. */
function rowsBelow(scroller: HTMLElement): number {
  const rows = scroller.getElementsByTagName("li");
  // A pixel of slack, so a row that fits exactly after rounding counts as shown.
  const edge = scroller.getBoundingClientRect().bottom + 1;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const bottom = rows[mid]?.getBoundingClientRect().bottom ?? 0;
    if (bottom > edge) hi = mid;
    else lo = mid + 1;
  }
  return rows.length - lo;
}

function LinkRow({
  node,
  relation,
  colourOf,
  onFocus,
}: {
  node: GraphNode;
  /** How the selected note links to this one; notes further away have none. */
  relation: string | null;
  colourOf: (node: GraphNode) => string;
  onFocus: (key: string) => void;
}) {
  return (
    <li>
      <button type="button" className="graph-link" onClick={() => onFocus(node.key)}>
        <span className="graph-link-head">
          <span className="graph-kind-dot" style={{ background: colourOf(node) }} />
          {relation !== null && <span className="graph-link-rel">{relation}</span>}
          <span>
            <span className="k-mono">{node.key}</span> · {kindLabel(node.kind)}
          </span>
        </span>
        <span className="graph-link-title">{node.title}</span>
      </button>
    </li>
  );
}

export function Inspector({
  node,
  data,
  visibleKeys,
  rank,
  colourOf,
  depths = null,
  onFocus,
  onAround,
  onClose,
}: InspectorProps) {
  // A hidden note would close the Inspector when clicked, with nothing on the canvas to show for it.
  const links = useMemo(
    () => neighboursOf(data, node.key, rank).filter((l) => visibleKeys.has(l.node.key)),
    [data, node.key, rank, visibleKeys],
  );
  const recorded = links.filter((l) => !l.edge.suggested);
  const suggested = links.filter((l) => l.edge.suggested);
  const byKey = useMemo(() => new Map(data.nodes.map((n) => [n.key, n])), [data]);
  // Only depths counted from this note list anything: depths from a hovered note would put that
  // note's neighbours under this one's title.
  const own = depths?.get(node.key) === 0 ? depths : null;
  const farther = useMemo(
    () =>
      own
        ? fartherNotes(
            own,
            byKey,
            new Set([node.key, ...links.map((l) => l.node.key)]),
            visibleKeys,
            rank,
          )
        : [],
    [own, byKey, node.key, links, visibleKeys, rank],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el) setBelow(rowsBelow(el));
  }, []);
  // Browsers fire scroll events and resize callbacks at most once a frame, so each measures at once.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [measure]);
  // A newly selected note's links start at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the selected note changes
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [node.key]);
  // New rows are measured once they are in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: links and farther are the rows
  useLayoutEffect(measure, [measure, links, farther]);

  const scrollOn = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Most of a page, so the row cut off at the bottom is still in sight at the top.
    const top = Math.max(el.clientHeight * 0.8, 1);
    if (typeof el.scrollBy === "function") {
      el.scrollBy({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } else {
      el.scrollTop += top;
    }
  };

  const row = (n: GraphNode, relation: string | null) => (
    <LinkRow key={n.key} node={n} relation={relation} colourOf={colourOf} onFocus={onFocus} />
  );

  return (
    <section className="ins" aria-label="Selected note">
      <div className="ins-top">
        <div className="ins-head">
          <span className="ins-swatch" style={{ background: colourOf(node) }} aria-hidden="true" />
          <h2 id="graph-inspector-title" className="ins-title">
            {node.title || node.key}
          </h2>
          <IconButton
            icon="close"
            label="Clear the selection"
            className="ins-close"
            onClick={onClose}
          />
          <p className="ins-meta">
            <span className="k-mono ins-key" title={node.key}>
              {node.key}
            </span>
            <span>{kindLabel(node.kind)}</span>
            {/* Most notes are active, so only the exceptions say so. */}
            {node.status !== "active" && <StatusPill tone={node.status}>{node.status}</StatusPill>}
          </p>
        </div>
        <div className="ins-actions">
          <a className="k-btn k-btn-primary" href={noteHref(node.domain, node.key)}>
            Open the note
          </a>
          <Button onClick={onAround}>Around this note</Button>
        </div>
      </div>

      <div ref={scrollRef} className="ins-scroll">
        {suggested.length > 0 && (
          <FindingCallout
            kind="Suggested link"
            compact
            actions={
              <a className="k-btn k-btn-sm" href="#/reflect">
                Show the finding
              </a>
            }
          >
            Reflect suggests linking <span className="k-mono">{node.key}</span> to{" "}
            {suggested.map((l, i) => (
              <span key={l.node.key}>
                {i > 0 ? ", " : ""}
                <span className="k-mono">{l.node.key}</span>
              </span>
            ))}
            . Neither note records it.
          </FindingCallout>
        )}
        {recorded.length === 0 ? (
          <p className="k-legend-note">No recorded links.</p>
        ) : (
          <>
            <h3 className="k-list-title">
              {count(recorded.length, "direct link", "direct links")}
            </h3>
            <ul className="graph-links">
              {recorded.map((l) =>
                row(l.node, l.outgoing ? sentence(l.edge.relation) : "Linked from"),
              )}
            </ul>
          </>
        )}
        {suggested.length > 0 && (
          <>
            {/* The callout above says these come from reflect. */}
            <h3 className="k-list-title">
              {count(suggested.length, "suggested link", "suggested links")}
            </h3>
            <ul className="graph-links graph-links-suggested">
              {suggested.map((l) =>
                row(l.node, l.outgoing ? sentence(l.edge.relation) : "Linked from"),
              )}
            </ul>
          </>
        )}
        {farther.map((level) => (
          <Fragment key={level.depth}>
            <h3 className="k-list-title">
              {count(level.total, "note", "notes")} {level.depth} links away
            </h3>
            <ul className="graph-links">{level.nodes.map((n) => row(n, null))}</ul>
            {/* Not a row, so the scroll hint does not count it. */}
            {level.total > level.nodes.length && (
              <p className="k-legend-note">
                And {formatCount(level.total - level.nodes.length)} more
              </p>
            )}
          </Fragment>
        ))}
        {below > 0 && (
          <div className="ins-more">
            {/* For the mouse: Tab already scrolls through the rows, and the headings give the counts.
                Pressing it leaves focus where it was: on this hidden button focus would be lost to
                screen readers, then dropped to the page when the hint goes at the end. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onMouseDown={(e) => e.preventDefault()}
              onClick={scrollOn}
            >
              Scroll for {formatCount(below)} more
              <Icon name="chevron" size={12} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
