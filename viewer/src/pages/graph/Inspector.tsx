// The selected note: what it is and every link it has, recorded or suggested by reflect.

import { useMemo } from "react";
import { type GraphData, type GraphNode, kindLabel } from "../../api";
import { noteHref } from "../../app/router";
import { Button, FindingCallout, IconButton, StatusPill } from "../../components/ui";
import { type KindRank, type Neighbour, neighboursOf, sentence } from "./model";

export interface InspectorProps {
  node: GraphNode;
  data: GraphData;
  /** Notes the filters leave on the canvas; links to any other note are left out. */
  visibleKeys: ReadonlySet<string>;
  rank: KindRank;
  colourOf: (node: GraphNode) => string;
  onFocus: (key: string) => void;
  onAround: () => void;
  onClose: () => void;
}

function LinkRow({
  n,
  colourOf,
  onFocus,
}: {
  n: Neighbour;
  colourOf: (node: GraphNode) => string;
  onFocus: (key: string) => void;
}) {
  return (
    <li>
      <button type="button" className="graph-link" onClick={() => onFocus(n.node.key)}>
        <span className="graph-link-head">
          <span className="graph-kind-dot" style={{ background: colourOf(n.node) }} />
          <span className="graph-link-rel">
            {n.outgoing ? sentence(n.edge.relation) : "Linked from"}
          </span>
          <span>
            <span className="k-mono">{n.node.key}</span> · {kindLabel(n.node.kind)}
          </span>
        </span>
        <span className="graph-link-title">{n.node.title}</span>
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
  return (
    <section className="graph-inspector" aria-labelledby="graph-inspector-title">
      <div className="graph-inspector-head">
        <h2 className="k-section-label" id="graph-inspector-title">
          Selected note
        </h2>
        <IconButton icon="close" label="Clear the selection" onClick={onClose} />
      </div>
      <p className="graph-inspector-meta">
        <span className="k-mono">{node.key}</span>
        <span>{kindLabel(node.kind)}</span>
        <StatusPill tone={node.status}>{node.status}</StatusPill>
      </p>
      <p className="graph-inspector-title">{node.title}</p>
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
      <h3 className="k-list-title">Links</h3>
      {recorded.length === 0 ? (
        <p className="k-legend-note">No recorded links.</p>
      ) : (
        <ul className="graph-links">
          {recorded.map((n) => (
            <LinkRow key={n.node.key} n={n} colourOf={colourOf} onFocus={onFocus} />
          ))}
        </ul>
      )}
      {suggested.length > 0 && (
        <>
          <h3 className="k-list-title">Suggested by reflect</h3>
          <ul className="graph-links graph-links-suggested">
            {suggested.map((n) => (
              <LinkRow key={n.node.key} n={n} colourOf={colourOf} onFocus={onFocus} />
            ))}
          </ul>
        </>
      )}
      <div className="graph-inspector-actions">
        <a className="k-btn k-btn-primary" href={noteHref(node.domain, node.key)}>
          Open the note
        </a>
        <Button onClick={onAround}>Around this note</Button>
      </div>
    </section>
  );
}
