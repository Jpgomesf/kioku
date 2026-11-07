// A Back button for pages reached from somewhere else, such as a note: it returns to the page
// the person came from, as they left it, and is named after it ("Library", "Graph"). With no
// earlier page in the app (it opened here), it goes to the page's parent instead.
import { backLabel, usePreviousRoute } from "../../app/history";
import { navigate } from "../../app/router";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

export interface BackButtonProps {
  /** Where to go when the app has no earlier page, and that page's name. */
  fallback: { href: string; label: string };
}

export function BackButton({ fallback }: BackButtonProps) {
  const previous = usePreviousRoute();
  const label = previous === undefined ? fallback.label : backLabel(previous);
  const target = label === "Back" ? "Back" : `Back to ${label}`;
  // ⌘[ only goes back within the app, so the fallback doesn't offer it.
  const name = previous === undefined ? target : `${target} (⌘[)`;
  return (
    <Button
      size="sm"
      variant="quiet"
      className="back-button"
      aria-label={name}
      title={name}
      onClick={() => (previous === undefined ? navigate(fallback.href) : window.history.back())}
    >
      <Icon name="back" />
      {label}
    </Button>
  );
}
