// A tiny hash router. Routes look like #/library?kind=decision, #/graph?domain=demo&focus=key
// or #/note/<domain>/<key>. Domains may contain a slash, so the graph takes them as params.
import { useEffect, useState } from "react";

/** Library filters, kept in the URL so the palette and other views can link to them. */
export interface LibraryParams {
  q?: string;
  /** One kind, or several as a comma-separated list such as "decision,fix". */
  kind?: string;
  status?: string;
  origin?: string;
  /** An ISO date (YYYY-MM-DD), or "last-visit" for the area's last visit. */
  since?: string;
}

const LIBRARY_KEYS = ["q", "kind", "status", "origin", "since"] as const;

export type Route =
  | { name: "library"; params: LibraryParams }
  | { name: "graph"; domain?: string; focus?: string }
  | { name: "note"; domain: string; key: string }
  | { name: "health" }
  | { name: "reflect"; domain?: string; finding?: string }
  | { name: "vaults" }
  | { name: "vaults-review" }
  | { name: "guide"; section: string | null }
  | { name: "not-found"; path: string };

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

function libraryParams(search: URLSearchParams): LibraryParams {
  const params: LibraryParams = {};
  for (const key of LIBRARY_KEYS) {
    const value = search.get(key);
    if (value) params[key] = value;
  }
  return params;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  let search: URLSearchParams;
  try {
    search = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  } catch {
    return { name: "not-found", path: raw };
  }
  const decoded = path.split("/").filter(Boolean).map(safeDecode);
  if (decoded.some((p) => p === null)) return { name: "not-found", path: raw };
  const [head, ...rest] = decoded as string[];
  const notFound: Route = { name: "not-found", path: raw };
  switch (head) {
    case undefined:
    case "library":
      return rest.length === 0 ? { name: "library", params: libraryParams(search) } : notFound;
    case "graph": {
      if (rest.length > 0) return notFound;
      const route: Route = { name: "graph" };
      const domain = search.get("domain");
      const focus = search.get("focus");
      if (domain) route.domain = domain;
      if (domain && focus) route.focus = focus;
      return route;
    }
    case "health":
      return rest.length === 0 ? { name: "health" } : notFound;
    case "reflect": {
      if (rest.length > 0) return notFound;
      const route: Route = { name: "reflect" };
      const domain = search.get("domain");
      const finding = search.get("finding");
      if (domain) route.domain = domain;
      if (domain && finding) route.finding = finding;
      return route;
    }
    case "vaults":
      if (rest.length === 0) return { name: "vaults" };
      return rest.length === 1 && rest[0] === "review" ? { name: "vaults-review" } : notFound;
    case "guide":
      return { name: "guide", section: rest.length > 0 ? rest.join("/") : null };
    case "note": {
      // Domains may contain a slash (personal/kioku): the key is the last part.
      const key = rest.at(-1);
      const domain = rest.slice(0, -1).join("/");
      if (key && domain) return { name: "note", domain, key };
      return notFound;
    }
    default:
      return notFound;
  }
}

export function noteHref(domain: string, key: string): string {
  return `#/note/${domain.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(key)}`;
}

/** The graph for an area, or around one note when `focus` is given. */
export function graphHref(domain: string, focus?: string): string {
  const search = new URLSearchParams({ domain });
  if (focus) search.set("focus", focus);
  return `#/graph?${search.toString()}`;
}

/** Reflect for an area, opened on one finding when `finding` is given. */
export function reflectHref(domain?: string, finding?: string): string {
  if (!domain) return "#/reflect";
  const search = new URLSearchParams({ domain });
  if (finding) search.set("finding", finding);
  return `#/reflect?${search.toString()}`;
}

export function libraryHref(params: LibraryParams = {}): string {
  const search = new URLSearchParams();
  for (const key of LIBRARY_KEYS) {
    const value = params[key];
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `#/library?${text}` : "#/library";
}

/**
 * Go to a hash route. When the URL already reads `hash` (for example after a page's
 * replaceState), a hashchange is dispatched anyway so a repeated link still lands.
 */
export function navigate(hash: string): void {
  if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
