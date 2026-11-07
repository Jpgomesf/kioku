// The HTML layer over the canvas: topic labels, the focus label, the focus card, the cards
// around it and their link lines and labels. It renders only when its content changes; the
// camera places it through OverlayPlacer (placer.ts), which reads the data-* points set here.
import { memo, type Ref } from "react";
import { type GraphNode, kindLabel, kindNoun, type NoteKind } from "../../api";
import { noteHref } from "../../app/router";
import { type ColourSlots, colourFor } from "./colours";
import type { Point } from "./layout";
import { type Card, cardKey, formatCount } from "./model";

/** A card of another type than the one highlighted in the legend. */
const CARD_DIM = 0.35;

/** The type a card stands for: its note's, or its group's. */
function cardKind(card: Card): NoteKind {
  return card.type === "group" ? card.kind : card.neighbour.node.kind;
}

export interface OverlayProps {
  rootRef: Ref<HTMLDivElement>;
  /** Topic notes and their points, labelled at the far steps. */
  topics: ReadonlyArray<{ key: string; title: string; at: Point }>;
  topicsOn: boolean;
  focusNode: GraphNode | null;
  focusPos: Point | null;
  cards: Card[];
  /** Each card's slot (world) and the dot it grows out of. */
  places: ReadonlyArray<{ slot: Point; from: Point } | null>;
  /** Cards (and the focus card) that have had their styled frame and may show. */
  ready: ReadonlySet<string>;
  /** Level 2 or 3 with a focus: the cards step. */
  shown: boolean;
  /** Level 3: link labels show. */
  labelsOn: boolean;
  litKind: NoteKind | null;
  slots: ColourSlots;
  onOpen: (key: string) => void;
  onExpand: (kind: NoteKind) => void;
}

const pt = (p: Point) => ({ "data-x": p.x, "data-y": p.y });
const from = (p: Point) => ({ "data-fx": p.x, "data-fy": p.y });

export const Overlay = memo(function Overlay(props: OverlayProps) {
  const { topics, topicsOn, focusNode, focusPos, cards, places, ready, shown, labelsOn } = props;
  const { litKind, slots, onOpen, onExpand, rootRef } = props;
  const isOn = (key: string) => shown && ready.has(key);
  return (
    <div ref={rootRef} className="graph-html">
      <svg className="graph-focus-edges" aria-hidden="true" style={{ opacity: shown ? 1 : 0 }}>
        {focusPos &&
          cards.map((card, i) => {
            const place = places[i];
            if (!place) return null;
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
                data-x1={focusPos.x}
                data-y1={focusPos.y}
                {...pt(place.slot)}
                {...from(place.from)}
                data-on={isOn(cardKey(card)) ? "1" : "0"}
              />
            );
          })}
      </svg>
      {topics.map((t) => (
        <span
          key={t.key}
          className="graph-topic-label"
          aria-hidden="true"
          {...pt(t.at)}
          data-anchor="top"
          data-dy={16}
          style={{ opacity: topicsOn ? 1 : 0 }}
        >
          {t.title}
        </span>
      ))}
      {focusNode && focusPos && (
        <span
          className="graph-dot-label"
          aria-hidden="true"
          {...pt(focusPos)}
          data-anchor="top"
          data-dy={12}
          style={{ opacity: shown ? 0 : 1 }}
        >
          {focusNode.key}
        </span>
      )}
      {focusPos &&
        cards.map((card, i) => {
          const place = places[i];
          if (!place || card.type !== "note") return null;
          const mid = {
            x: (focusPos.x + place.slot.x) / 2,
            y: (focusPos.y + place.slot.y) / 2,
          };
          const e = card.neighbour.edge;
          const on = isOn(cardKey(card)) && labelsOn;
          return (
            <span
              key={`label:${cardKey(card)}`}
              className={`graph-edge-label${e.suggested ? " graph-edge-label-suggested" : ""}`}
              aria-hidden={!on}
              {...pt(mid)}
              data-scale="detail"
              style={{ opacity: on ? 1 : 0 }}
            >
              {e.relation}
              {e.suggested ? " · not recorded" : ""}
            </span>
          );
        })}
      {focusNode &&
        focusPos &&
        (() => {
          const on = isOn(`focus:${focusNode.key}`);
          return (
            <a
              key={focusNode.key}
              className="k-node graph-card graph-card-focus"
              href={noteHref(focusNode.domain, focusNode.key)}
              tabIndex={on ? 0 : -1}
              inert={!on}
              {...pt(focusPos)}
              data-scale="detail"
              data-grow="1"
              data-on={on ? "1" : "0"}
              style={{ opacity: on ? 1 : 0, pointerEvents: on ? "auto" : "none" }}
            >
              <span className="k-node-kind">
                <span>
                  <span className="k-mono">{focusNode.key}</span> · {kindLabel(focusNode.kind)}
                </span>
              </span>
              <span className="k-node-title">{focusNode.title}</span>
            </a>
          );
        })()}
      {focusPos &&
        cards.map((card, i) => {
          const place = places[i];
          if (!place) return null;
          const on = isOn(cardKey(card));
          const dim = litKind !== null && cardKind(card) !== litKind;
          return (
            <CardButton
              key={cardKey(card)}
              card={card}
              slots={slots}
              dim={dim}
              shown={on}
              slot={place.slot}
              from={place.from}
              onOpen={onOpen}
              onExpand={onExpand}
            />
          );
        })}
    </div>
  );
});

interface CardButtonProps {
  card: Card;
  slots: ColourSlots;
  shown: boolean;
  /** Another type is highlighted in the legend. */
  dim: boolean;
  slot: Point;
  from: Point;
  onOpen: (key: string) => void;
  onExpand: (kind: NoteKind) => void;
}

function CardButton({
  card,
  slots,
  shown,
  dim,
  slot,
  from: start,
  onOpen,
  onExpand,
}: CardButtonProps) {
  const placed = {
    ...pt(slot),
    ...from(start),
    "data-scale": "detail",
    "data-grow": "1",
    "data-on": shown ? "1" : "0",
    style: { opacity: shown ? (dim ? CARD_DIM : 1) : 0, pointerEvents: shown ? "auto" : "none" },
    tabIndex: shown ? 0 : -1,
    "aria-hidden": !shown,
    inert: !shown,
  } as const;
  const fade = dim ? " graph-dim" : "";
  if (card.type === "group") {
    const n = card.members.length;
    return (
      <button
        type="button"
        className={`k-node graph-card graph-card-group${fade}`}
        {...placed}
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
    <button type="button" className={cls} {...placed} onClick={() => onOpen(node.key)}>
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
