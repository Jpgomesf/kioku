// The selected note: what it is and every link it has, recorded or suggested by reflect.

import { useMemo } from "react";
import type { GraphData, GraphNode } from "../../api";
import { noteHref } from "../../app/router";
import { Button, FindingCallout, IconButton, StatusPill } from "../../components/ui";
import { KIND_LABEL, type Neighbour, neighboursOf, sentence, typeColour } from "./model";

export interface InspectorProps {
  node: GraphNode;
  data: GraphData;
  onFocus: (key: string) => void;
  onAround: () => void;
  onClose: () => void;
}

function LinkRow({ n, onFocus }: { n: Neighbour; onFocus: (key: string) => void }) {
  return (
    <li>
      <button type="button" className="graph-link" onClick={() => onFocus(n.node.key)}>
        <span className="graph-link-head">
          <span className="graph-kind-dot" style={{ background: typeColour(n.node.kind) }} />
          <span className="graph-link-rel">
            {n.outgoing ? sentence(n.edge.relation) : "Linked from"}
          </span>
          <span className="k-mono">{n.node.key}</span>
        </span>
        <span className="graph-link-title">{n.node.title}</span>
      </button>
    </li>
  );
}

export function Inspector({ node, data, onFocus, onAround, onClose }: InspectorProps) {
  const links = useMemo(() => neighboursOf(data, node.key), [data, node.key]);
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
        <span>{KIND_LABEL[node.kind]}</span>
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
            <LinkRow key={n.node.key} n={n} onFocus={onFocus} />
          ))}
        </ul>
      )}
      {suggested.length > 0 && (
        <>
          <h3 className="k-list-title">Suggested by reflect</h3>
          <ul className="graph-links graph-links-suggested">
            {suggested.map((n) => (
              <LinkRow key={n.node.key} n={n} onFocus={onFocus} />
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
