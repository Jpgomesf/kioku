import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AreaSwitcher } from "../components/area-switcher";
import { Palette } from "../components/palette";
import { Sidebar } from "../components/shell/Sidebar";
import { ToastHost } from "../components/ui/Toast";
import { canViewTransition, runViewTransition, usePrefersReducedMotion } from "../motion";
import { GraphPage } from "../pages/graph";
import { GuidePage } from "../pages/guide";
import { HealthPage } from "../pages/health";
import { LibraryPage } from "../pages/library";
import { NotePage } from "../pages/note";
import { ReflectPage } from "../pages/reflect";
import { ReviewPage, VaultsPage } from "../pages/vaults";
import { ErrorBoundary } from "./ErrorBoundary";
import { type Route, useRoute } from "./router";
import { useGlobalShortcuts } from "./shortcuts";

function Outlet({ route }: { route: Route }) {
  switch (route.name) {
    case "library":
      return <LibraryPage params={route.params} />;
    case "graph":
      return <GraphPage domain={route.domain} focus={route.focus} />;
    case "note":
      return <NotePage domain={route.domain} noteKey={route.key} />;
    case "health":
      return <HealthPage />;
    case "reflect":
      return <ReflectPage domain={route.domain} finding={route.finding} />;
    case "vaults":
      return <VaultsPage />;
    case "vaults-review":
      return <ReviewPage />;
    case "guide":
      return <GuidePage section={route.section} />;
    case "not-found":
      return (
        <section className="page">
          <h1>Page not found</h1>
          <a href="#/library">Go to the library</a>
        </section>
      );
  }
}

/** Which page a route shows: param changes within one page keep the same key. */
export function pageKey(route: Route): string {
  return route.name === "note" ? `note:${route.domain}/${route.key}` : route.name;
}

/**
 * The route on screen. A change of page swaps inside a view transition (none under
 * reduced motion); a change within one page (filters, graph focus) applies at once.
 */
function useShownRoute(): Route {
  const route = useRoute();
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(route);
  useEffect(() => {
    if (route === shown) return;
    if (pageKey(route) === pageKey(shown) || !canViewTransition({ reduced })) {
      setShown(route);
      return;
    }
    // flushSync only runs inside the transition callback, never in this effect.
    void runViewTransition(() => flushSync(() => setShown(route)), { reduced, type: "route" });
  }, [route, shown, reduced]);
  return shown;
}

/** On a page change: scroll the main pane to the top and keep focus out of <body>. */
function usePageChangeReset(page: string): RefObject<HTMLElement | null> {
  const mainRef = useRef<HTMLElement>(null);
  const previous = useRef(page);
  useLayoutEffect(() => {
    if (previous.current === page) return;
    previous.current = page;
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    const active = document.activeElement;
    if (!active || active === document.body || main.contains(active)) {
      main.focus({ preventScroll: true });
    }
  }, [page]);
  return mainRef;
}

export function App() {
  const route = useShownRoute();
  const mainRef = usePageChangeReset(pageKey(route));
  useGlobalShortcuts();
  return (
    <div className="app">
      <Sidebar route={route} />
      <main className="app-main" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary resetKey={JSON.stringify(route)}>
          <Outlet route={route} />
        </ErrorBoundary>
      </main>
      <Palette />
      <AreaSwitcher />
      <ToastHost />
    </div>
  );
}
