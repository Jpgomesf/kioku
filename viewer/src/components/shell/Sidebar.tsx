// The app sidebar, as in the Main board: views, recent areas and one services line.
import { useEffect, useId, useState } from "react";
import {
  type Area,
  embeddingServiceName,
  embeddingWhere,
  getServiceStatus,
  getVaultsConfig,
  listReflectRuns,
  type ServiceHealth,
  type ServiceState,
  type ServiceStatus,
  toCommandError,
} from "../../api";
import { pickArea, reconcileAreas, useCurrentArea, useRecentAreas } from "../../app/area";
import { refreshAreas } from "../../app/overlay";
import type { Route } from "../../app/router";
import { toggleSidebar, useSidebarCollapsed } from "../../app/sidebar";
import { confirmedOpen } from "../../pages/reflect/state";
import { useOpenRequestCount } from "../../pages/vaults/draft";
import { openAreaSwitcher } from "../area-switcher";
import { Icon, type IconName } from "../ui/Icon";

interface NavEntry {
  href: string;
  label: string;
  icon: IconName;
  matches: Route["name"][];
  badge?: "findings" | "requests";
}

const NAV: NavEntry[] = [
  { href: "#/library", label: "Library", icon: "library", matches: ["library", "note"] },
  { href: "#/graph", label: "Graph", icon: "graph", matches: ["graph"] },
  {
    href: "#/health",
    label: "Health",
    icon: "health",
    matches: ["health", "reflect"],
    badge: "findings",
  },
  {
    href: "#/vaults",
    label: "Vaults and visibility",
    icon: "lock",
    matches: ["vaults", "vaults-review"],
    badge: "requests",
  },
  { href: "#/guide", label: "Guide", icon: "book", matches: ["guide"] },
];

const BADGE_WORDS: Record<NonNullable<NavEntry["badge"]>, [string, string]> = {
  findings: ["finding", "findings"],
  requests: ["access request", "access requests"],
};

const SERVICE_ROWS: { id: "postgres" | "qdrant" | "ollama"; name: string }[] = [
  { id: "postgres", name: "PostgreSQL" },
  { id: "qdrant", name: "Qdrant" },
  { id: "ollama", name: "Ollama" },
];

export type ServicesView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; status: ServiceStatus };

export function overall(status: ServiceStatus): ServiceState {
  const states = SERVICE_ROWS.map((r) => status[r.id].state);
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  return "running";
}

/** Names of the services in the given state, in display order. */
export function servicesIn(status: ServiceStatus, state: ServiceState): string[] {
  return SERVICE_ROWS.filter((r) => status[r.id].state === state).map((r) => r.name);
}

function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function summaryText(status: ServiceStatus, state: ServiceState): string {
  if (state === "running") return "All services running";
  const names = servicesIn(status, state);
  const verb = names.length === 1 ? "is" : "are";
  return `${joinNames(names)} ${verb} ${state}`;
}

/** The services line's tone and words. Only real data can say "running". */
export function servicesSummary(view: ServicesView): {
  tone: "loading" | "unknown" | ServiceState;
  text: string;
} {
  switch (view.kind) {
    case "loading":
      return { tone: "loading", text: "Checking services…" };
    case "error":
      return { tone: "unknown", text: "Services unknown" };
    case "ok": {
      const state = overall(view.status);
      return { tone: state, text: summaryText(view.status, state) };
    }
  }
}

function areaLabel(domain: string, areas: Area[]): { label: string; vault: string } {
  const area = areas.find((a) => a.domain === domain);
  return area
    ? { label: area.label, vault: area.vault }
    : { label: domain.split("/").at(-1) ?? domain, vault: "" };
}

export const SERVICES_REFRESH_MS = 30_000;

export interface SidebarProps {
  route: Route;
}

export function Sidebar({ route }: SidebarProps) {
  const currentDomain = useCurrentArea();
  const recentDomains = useRecentAreas();
  const [areas, setAreas] = useState<Area[]>([]);
  const [services, setServices] = useState<ServicesView>({ kind: "loading" });
  const [findingBadge, setFindingBadge] = useState(0);
  const requestBadge = useOpenRequestCount();
  // Collapsed, the sidebar is a rail of icons: names become tooltips and stay readable.
  const collapsed = useSidebarCollapsed();
  // The first switch turns on the fade that hides the swap, so launch doesn't fade in.
  const [lastCollapsed, setLastCollapsed] = useState(collapsed);
  const [switched, setSwitched] = useState(false);
  if (collapsed !== lastCollapsed) {
    setLastCollapsed(collapsed);
    setSwitched(true);
  }
  const badges = { findings: findingBadge, requests: requestBadge };
  // The findings badge reloads when Reflect or Health opens, where runs change.
  const onReflectOrHealth = route.name === "reflect" || route.name === "health";

  const servicesUp = services.kind === "ok" && overall(services.status) === "running";

  // Areas: loaded at start and again when the services come up, shared with the picker.
  // Once known, a current area that doesn't exist is replaced by a real one.
  useEffect(() => {
    void servicesUp;
    let live = true;
    refreshAreas().then(
      (a) => {
        if (!live) return;
        setAreas(a);
        getVaultsConfig()
          .then((config) =>
            config.vaults.flatMap((v) => (v.defaultDomain ? [v.defaultDomain] : [])),
          )
          .catch((): string[] => [])
          .then((preferred) => {
            if (live) reconcileAreas(a, preferred);
          });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [servicesUp]);

  // Services: refreshed on an interval and when the window comes back; the last answer
  // stays on screen while a refresh is in flight.
  useEffect(() => {
    let live = true;
    // Focus, visibilitychange and the interval can overlap: one request at a time, and
    // only the latest answer is applied.
    let latest = 0;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      latest += 1;
      const id = latest;
      const current = () => live && id === latest;
      getServiceStatus()
        .then(
          (status) => current() && setServices({ kind: "ok", status }),
          (err: unknown) =>
            current() && setServices({ kind: "error", message: toCommandError(err).message }),
        )
        .finally(() => {
          if (id === latest) inFlight = false;
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, SERVICES_REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    void onReflectOrHealth;
    let live = true;
    listReflectRuns(currentDomain).then(
      (runs) => live && setFindingBadge(confirmedOpen(runs).length),
      () => live && setFindingBadge(0),
    );
    return () => {
      live = false;
    };
  }, [currentDomain, onReflectOrHealth]);

  // Recent areas: the remembered ones first, then the current one, filled from the list.
  const listed = new Set(areas.map((a) => a.domain));
  const recent = [...new Set([currentDomain, ...recentDomains, ...areas.map((a) => a.domain)])]
    .filter((d) => areas.length === 0 || listed.has(d))
    .slice(0, 3);
  const toggleLabel = collapsed ? "Expand the sidebar (⌘\\)" : "Collapse the sidebar (⌘\\)";
  return (
    <nav
      className="k-sidebar"
      aria-label="Views and areas"
      data-collapsed={collapsed || undefined}
      data-switched={switched || undefined}
    >
      <div className="sidebar-top">
        {/* In the rail the brand is its kanji alone, which reads "kioku". */}
        <div className="k-brand" title={collapsed ? "Kioku" : undefined}>
          {collapsed ? null : "Kioku "}
          <span lang="ja">記憶</span>
        </div>
        <button
          type="button"
          className="k-btn k-btn-icon"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      <div className="k-nav">
        {NAV.map((item) => {
          const n = item.badge ? badges[item.badge] : 0;
          const words = item.badge ? BADGE_WORDS[item.badge] : null;
          return (
            <a
              key={item.href}
              className="k-nav-item"
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={item.matches.includes(route.name) ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span className={collapsed ? "k-sr" : undefined}>{item.label}</span>
              {words && n > 0 ? (
                <span className="k-nav-badge">
                  {n}
                  <span className="k-sr"> {n === 1 ? words[0] : words[1]}</span>
                </span>
              ) : null}
            </a>
          );
        })}
      </div>
      <div className="k-areas">
        <div className="sidebar-recent-head">
          {collapsed ? null : <span className="k-section-label">Recent areas</span>}
          <button
            type="button"
            className="k-btn k-btn-icon"
            aria-haspopup="dialog"
            aria-label="Find an area (⌘O)"
            title="Find an area (⌘O)"
            onClick={openAreaSwitcher}
          >
            <Icon name="search" />
          </button>
        </div>
        {(collapsed ? [] : recent).map((domain) => {
          const { label, vault } = areaLabel(domain, areas);
          return (
            <button
              type="button"
              key={domain}
              className="k-area-row"
              title={domain}
              aria-current={domain === currentDomain ? "true" : undefined}
              onClick={() => pickArea(domain)}
            >
              <span>{label}</span>
              {vault ? <span className="k-area-in">{vault}</span> : null}
            </button>
          );
        })}
      </div>
      <ServicesLine services={services} collapsed={collapsed} />
    </nav>
  );
}

function ServicesLine({ services, collapsed }: { services: ServicesView; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = servicesSummary(services);
  // The rail has room for the dot only: a click there expands the sidebar with the details.
  const shown = open && !collapsed;
  return (
    <div className="sidebar-services" data-state={summary.tone} data-open={shown || undefined}>
      <button
        type="button"
        className="sidebar-services-toggle"
        aria-expanded={shown}
        aria-controls={panelId}
        title={collapsed ? summary.text : undefined}
        onClick={() => {
          if (collapsed) {
            toggleSidebar();
            setOpen(true);
          } else {
            setOpen((o) => !o);
          }
        }}
      >
        <span className="k-dot" />
        <span className={collapsed ? "k-sr" : "k-grow"} role="status" aria-live="polite">
          {summary.text}
        </span>
        <Icon name="chevron" className="sidebar-chevron" />
      </button>
      <div className="sidebar-services-panel" id={panelId} inert={!shown}>
        <div className="sidebar-services-inner">
          {services.kind === "ok" ? <ServiceDetails status={services.status} /> : null}
          {services.kind === "error" ? (
            <p className="sidebar-services-error">Can't reach Kioku: {services.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ name, health }: { name: string; health: ServiceHealth }) {
  const className =
    health.state === "down"
      ? "k-down"
      : health.state === "degraded"
        ? "sidebar-degraded"
        : undefined;
  return (
    <li className={className}>
      <span className="k-dot" />
      <span className="k-grow">{name}</span>
      <span className="k-role">
        {health.detail}
        {health.state === "running" ? "" : `, ${health.state}`}
      </span>
    </li>
  );
}

function ServiceDetails({ status }: { status: ServiceStatus }) {
  return (
    <div className="k-services" style={{ marginTop: "var(--space-6)" }}>
      <ul className="k-services-rows">
        {SERVICE_ROWS.map((r) => (
          <ServiceRow
            key={r.id}
            name={r.id === "ollama" ? embeddingServiceName(status) : r.name}
            health={status[r.id]}
          />
        ))}
      </ul>
      <div className="k-services-embed">
        Embeddings: <span className="k-mono">{status.embeddingModel}</span>,{" "}
        {embeddingWhere(status)}
      </div>
    </div>
  );
}
