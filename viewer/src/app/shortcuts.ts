// Global shortcuts: ⌘K toggles the palette, ⌘O the area switcher, ⌘\ the sidebar and ⌘[
// goes back (Ctrl on other systems; on macOS Ctrl keeps its text-editing meaning). Escape
// closes whichever overlay is open. Keys typed through an input method are left alone.
import { useEffect } from "react";
import { canGoBack } from "./history";
import { closeOverlay, currentOverlay, hasCommandKey, toggleOverlay } from "./overlay";
import { toggleSidebar } from "./sidebar";

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && currentOverlay() !== null) {
        event.preventDefault();
        closeOverlay();
        return;
      }
      if (!hasCommandKey(event) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        toggleOverlay("palette");
      } else if (key === "o") {
        event.preventDefault();
        toggleOverlay("area-switcher");
      } else if (key === "\\") {
        event.preventDefault();
        toggleSidebar();
      } else if (key === "[" && canGoBack()) {
        // Only within the app: the first page has nothing before it to go back to.
        event.preventDefault();
        window.history.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
