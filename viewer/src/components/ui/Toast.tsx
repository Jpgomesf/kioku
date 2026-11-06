// One toast at a time, bottom right. Done toasts leave after 6 seconds; errors stay.
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { Icon } from "./Icon";

export type ToastTone = "ok" | "error" | "info";

export interface ToastMessage {
  tone: ToastTone;
  text: ReactNode;
  /** A quiet way back, such as Restore. */
  action?: { label: string; onClick: () => void };
}

let current: (ToastMessage & { id: number }) | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function showToast(message: ToastMessage): void {
  current = { ...message, id: nextId };
  nextId += 1;
  emit();
}

export function dismissToast(): void {
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Render once in the shell. Screen readers hear toasts through two live regions that are
 * always in the page, polite for done and info and assertive for errors; only their text
 * changes, since a region inserted with its text already in it is often not announced.
 */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const timer = window.setTimeout(dismissToast, 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const isError = toast?.tone === "error";
  return (
    <div className="app-toasts">
      <div className="k-sr" role="status" aria-live="polite" aria-atomic="true">
        {toast && !isError ? toast.text : null}
      </div>
      <div className="k-sr" role="alert" aria-live="assertive" aria-atomic="true">
        {toast && isError ? toast.text : null}
      </div>
      {toast ? (
        <div
          key={toast.id}
          className={`k-toast${toast.tone === "info" ? "" : ` k-toast-${toast.tone}`}`}
        >
          <Icon
            name={toast.tone === "error" ? "finding" : toast.tone === "info" ? "notice" : "check"}
          />
          <div className="k-toast-text">{toast.text}</div>
          {toast.action ? (
            <button
              type="button"
              className="k-btn k-btn-quiet k-btn-sm"
              onClick={toast.action.onClick}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="k-btn k-btn-quiet k-btn-icon k-btn-sm"
            aria-label="Close"
            onClick={dismissToast}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
