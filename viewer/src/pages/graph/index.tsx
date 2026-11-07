// The Graph page: one semantic zoom from the whole area down to a note's neighbourhood.
// Without a domain in the URL it shows the current area; with a focus it opens zoomed on it.
import { useEffect, useRef, useState } from "react";
import { type Area, type GraphData, getGraph, listAreas } from "../../api";
import { useCurrentArea } from "../../app/area";
import { openOverlay, useOverlay } from "../../app/overlay";
import { graphHref, navigate } from "../../app/router";
import { AreaButton, EmptyState } from "../../components/ui";
import { GraphView } from "./GraphView";
import "./graph.css";

export interface GraphPageProps {
  domain?: string | undefined;
  focus?: string | undefined;
}

type Load =
  | { state: "loading"; domain: string }
  | { state: "ready"; domain: string; data: GraphData }
  | { state: "error"; domain: string; message: string };

export function GraphPage({ domain, focus }: GraphPageProps) {
  const current = useCurrentArea();
  const area = domain ?? current;
  const [load, setLoad] = useState<Load>({ state: "loading", domain: area });
  const [areas, setAreas] = useState<Area[]>([]);
  const overlay = useOverlay();

  // The area picker wins over a domain in the URL: a new pick drops the old domain and focus.
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (current === lastCurrent.current) return;
    lastCurrent.current = current;
    if (domain !== current) navigate(graphHref(current));
  }, [current, domain]);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading", domain: area });
    getGraph({ domain: area }).then(
      (data) => {
        // GraphView lays out in a worker and says so while it arranges the notes.
        if (live) setLoad({ state: "ready", domain: area, data });
      },
      (err: unknown) =>
        live &&
        setLoad({
          state: "error",
          domain: area,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [area]);

  useEffect(() => {
    let live = true;
    listAreas().then(
      (list) => live && setAreas(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const info = areas.find((a) => a.domain === area);
  const areaButton = (
    <AreaButton
      label={info?.label ?? area}
      vault={info?.vault ?? "…"}
      expanded={overlay === "area-switcher"}
      onClick={() => openOverlay("area-switcher")}
    />
  );
  const label = info?.label ?? area;

  return (
    <section className="page-panes graph-page" aria-labelledby="graph-title">
      {load.state === "ready" && load.domain === area ? (
        <GraphView
          key={area}
          domain={area}
          areaLabel={label}
          data={load.data}
          initialFocus={focus}
          areaButton={areaButton}
        />
      ) : (
        <div className="graph-main">
          <header className="graph-head">
            <div className="graph-head-text">
              <h1 id="graph-title">Graph</h1>
              <p className="k-count" aria-live="polite">
                {load.state === "error" ? "The graph didn't load." : `Loading ${label}…`}
              </p>
            </div>
            {areaButton}
          </header>
          {load.state === "error" && (
            <div className="graph-empty">
              <EmptyState title="The graph didn't load">{load.message}</EmptyState>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
