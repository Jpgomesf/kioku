// The HTML layer over the canvas: the focus label, the focus card, the cards around it and
// their link lines and labels (topics are named on the canvas, with the other labels, so none
// piles on another). It renders only when its content changes; the
// camera places it through OverlayPlacer (placer.ts), which reads the data-* points set here.
// Points name notes by key (data-k), so the placer follows the live layout without React.
import { memo, type Ref } from "react";
import { type GraphNode, kindLabel, kindNoun, type NoteKind } from "../../api";
import { noteHref } from "../../app/router";
import type { Point } from "./layout";
import { type Card, cardKey, formatCount } from "./model";

/** A card outside the notes a settings group highlights. */
const CARD_DIM = 0.35;

/** The notes a card stands for: its note, or its group's members. */
function cardKeys(card: Card): string[] {
  return card.type === "group" ? card.members.map((m) => m.node.key) : [card.neighbour.node.key];
}

/** Where a card sits, as a world offset from the focus note, and the note it grows from. */
export interface CardPlace {
  offset: Point;
  fromKey: string;
}

export interface OverlayProps {
  rootRef: Ref<HTMLDivElement>;
  /** The focus note, when it has a position. */
  focusNode: GraphNode | null;
  cards: Card[];
  places: ReadonlyArray<CardPlace | null>;
  /** Cards (and the focus card) that have had their styled frame and may show. */
  ready: ReadonlySet<string>;
  /** Level 2 or 3 with a focus: the cards step. */
  shown: boolean;
  /** Level 3: link labels show. */
  labelsOn: boolean;
  /** Notes a settings group highlights; the other cards step back. */
  lit: ReadonlySet<string> | null;
  colourOf: (node: GraphNode) => string;
  onOpen: (key: string) => void;
  onExpand: (kind: NoteKind) => void;
}

/** A point at a note's live position, plus an optional world offset. */
const at = (key: string, offset?: Point) => ({
  "data-k": key,
  ...(offset ? { "data-x": offset.x, "data-y": offset.y } : {}),
});
const growsFrom = (key: string) => ({ "data-fk": key, "data-fx": 0, "data-fy": 0 });

export const Overlay = memo(function Overlay(props: OverlayProps) {
  const { focusNode, cards, places, ready, shown, labelsOn } = props;
  const { lit, colourOf, onOpen, onExpand, rootRef } = props;
  const isOn = (key: string) => shown && ready.has(key);
  const isDim = (card: Card) => lit !== null && !cardKeys(card).some((k) => lit.has(k));
  const focusKey = focusNode?.key ?? null;
  return (
    <div ref={rootRef} className="graph-html">
      <svg className="graph-focus-edges" aria-hidden="true" style={{ opacity: shown ? 1 : 0 }}>
        {focusKey &&
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
            const fade = isDim(card) ? " graph-dim" : "";
            return (
              <line
                key={cardKey(card)}
                className={`graph-edge-strong${edgeClass}${fade}`}
                data-k1={focusKey}
                {...at(focusKey, place.offset)}
                {...growsFrom(place.fromKey)}
                data-on={isOn(cardKey(card)) ? "1" : "0"}
              />
            );
          })}
      </svg>
      {focusNode && (
        <span
          className="graph-dot-label"
          aria-hidden="true"
          {...at(focusNode.key)}
          data-anchor="top"
          data-dy={12}
          style={{ opacity: shown ? 0 : 1 }}
        >
          {focusNode.key}
        </span>
      )}
      {focusKey &&
        cards.map((card, i) => {
          const place = places[i];
          if (!place || card.type !== "note") return null;
          const mid = { x: place.offset.x / 2, y: place.offset.y / 2 };
          const e = card.neighbour.edge;
          const on = isOn(cardKey(card)) && labelsOn;
          return (
            <span
              key={`label:${cardKey(card)}`}
              className={`graph-edge-label${e.suggested ? " graph-edge-label-suggested" : ""}`}
              aria-hidden={!on}
              {...at(focusKey, mid)}
              data-scale="detail"
              style={{ opacity: on ? 1 : 0 }}
            >
              {e.relation}
              {e.suggested ? " · not recorded" : ""}
            </span>
          );
        })}
      {focusNode &&
        (() => {
          const on = isOn(`focus:${focusNode.key}`);
          return (
            <a
              key={focusNode.key}
              className="k-node graph-card graph-card-focus"
              href={noteHref(focusNode.domain, focusNode.key)}
              tabIndex={on ? 0 : -1}
              inert={!on}
              {...at(focusNode.key)}
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
      {focusKey &&
        cards.map((card, i) => {
          const place = places[i];
          if (!place) return null;
          const on = isOn(cardKey(card));
          return (
            <CardButton
              key={cardKey(card)}
              card={card}
              colourOf={colourOf}
              dim={isDim(card)}
              shown={on}
              focusKey={focusKey}
              place={place}
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
  colourOf: (node: GraphNode) => string;
  shown: boolean;
  /** A settings group highlights other notes. */
  dim: boolean;
  focusKey: string;
  place: CardPlace;
  onOpen: (key: string) => void;
  onExpand: (kind: NoteKind) => void;
}

function CardButton({
  card,
  colourOf,
  shown,
  dim,
  focusKey,
  place,
  onOpen,
  onExpand,
}: CardButtonProps) {
  const placed = {
    ...at(focusKey, place.offset),
    ...growsFrom(place.fromKey),
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
            <span
              className="graph-kind-dot"
              style={{ background: card.members[0] ? colourOf(card.members[0].node) : undefined }}
            />
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
          <span className="graph-kind-dot" style={{ background: colourOf(node) }} />
          <span className="k-mono">{node.key}</span> · {kindLabel(node.kind)}
        </span>
        {legacy && <span>superseded</span>}
        {edge.suggested && <span className="k-node-flag">suggested</span>}
      </span>
      <span className="k-node-title">{node.title}</span>
    </button>
  );
}
