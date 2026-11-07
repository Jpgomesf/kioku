// The one modal shell: a fixed scrim, aria-modal, focus moved in on open, Tab kept
// inside, and focus returned to the opener on close. Escape is handled by the caller
// (useGlobalShortcuts closes the open overlay) and by onClose here for standalone use.
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** Accessible name, unless labelledBy points at a visible heading. */
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  children: ReactNode;
  /** Class for the panel, such as "k-dialog" or "k-palette". */
  className?: string;
  /** Where the panel sits: centered (dialogs) or near the top (palette, area picker). */
  placement?: "center" | "top";
}

export function Dialog({
  label,
  labelledBy,
  onClose,
  children,
  className = "k-dialog",
  placement = "center",
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    first?.focus();
    return () => opener?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape during IME composition cancels the composition, not the dialog.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    // Focus on the panel itself (or anything outside the list) wraps too, so Tab never
    // leaves the modal.
    const active = document.activeElement as HTMLElement | null;
    const outside = !active || !items.includes(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the scrim is a mouse shortcut; Escape and the dialog's own buttons are the keyboard path.
    <div
      className={`app-scrim app-scrim-${placement}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className}
        onKeyDown={onKeyDown}
        // A click on plain content (a heading, a status line) would move focus to the
        // panel and away from the input whose key handlers drive the palette.
        onMouseDown={(event) => {
          if (!(event.target as Element).closest(FOCUSABLE)) event.preventDefault();
        }}
      >
        {children}
      </div>
    </div>
  );
}
