import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";

export interface ConfirmBlockProps {
  /** The action named after the change: "Allow", "Turn off", "Add the area". */
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
  busy?: boolean;
  /**
   * True only once the backend can ask macOS for Touch ID or a password
   * (AppInfo.canAuthenticate). Until then the block promises no such step.
   */
  canAuthenticate?: boolean;
  /** Shown instead of the Touch ID line when authentication isn't available. */
  note?: string;
}

/**
 * The one place a change to who can read memory is confirmed, by a person.
 * Focus never lands on the confirm button by default.
 */
export function ConfirmBlock({
  actionLabel,
  onConfirm,
  onCancel,
  cancelLabel = "Don't allow",
  busy = false,
  canAuthenticate = false,
  note = "Check the change above before you confirm it.",
}: ConfirmBlockProps) {
  return (
    <div className="k-confirm">
      <div className="k-confirm-head">
        <span className="k-section-label">Only you can allow this</span>
        <StatusPill tone="draft">Proposed</StatusPill>
      </div>
      {canAuthenticate ? (
        <p>
          macOS asks for your fingerprint or password. Agents can ask for access, but can't pass
          this step.
        </p>
      ) : (
        <p>{note}</p>
      )}
      <div className="k-confirm-actions">
        <button
          type="button"
          className="k-btn k-btn-primary k-btn-lg"
          onClick={onConfirm}
          disabled={busy}
        >
          {canAuthenticate ? (
            <>
              <Icon name="fingerprint" />
              {actionLabel} with Touch ID
            </>
          ) : (
            actionLabel
          )}
        </button>
        <button type="button" className="k-btn k-btn-lg" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
