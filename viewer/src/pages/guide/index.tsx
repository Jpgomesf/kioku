import { type ReactNode, useEffect, useState } from "react";
import {
  type AppInfo,
  checkForUpdates,
  getAppInfo,
  listReleaseNotes,
  toCommandError,
  type UpdateStatus,
} from "../../api";
import { Button, Kbd, StatusPill } from "../../components/ui";
import { formatReleaseDate, groupReleaseNotes, isIsoDate, type ReleaseEntry } from "./releases";
import "./guide.css";

export interface GuidePageProps {
  section: string | null;
}

export type GuideSection = "getting-started" | "shortcuts" | "whats-new" | "updates";

export const GUIDE_SECTIONS: { id: GuideSection; label: string }[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "whats-new", label: "What's new" },
  { id: "updates", label: "Updates" },
];

export function resolveSection(section: string | null): GuideSection {
  const found = GUIDE_SECTIONS.find((s) => s.id === section);
  return found === undefined ? "getting-started" : found.id;
}

export function GuidePage({ section }: GuidePageProps) {
  const current = resolveSection(section);
  const label = GUIDE_SECTIONS.find((s) => s.id === current)?.label ?? "Guide";
  return (
    <section className="page k-guide" aria-labelledby="guide-title">
      <nav className="k-guide-nav" aria-label="Guide sections">
        <ul>
          {GUIDE_SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#/guide/${s.id}`} aria-current={s.id === current ? "page" : undefined}>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="k-guide-body">
        <h1 id="guide-title">{label}</h1>
        {current === "getting-started" && <GettingStarted />}
        {current === "shortcuts" && <Shortcuts />}
        {current === "whats-new" && <WhatsNew />}
        {current === "updates" && <Updates />}
      </div>
    </section>
  );
}

function GettingStarted() {
  return (
    <>
      <p>
        Kioku Viewer shows what Kioku remembers: notes, how they link, and how healthy they are.
      </p>
      <h2>Vaults and areas</h2>
      <p>
        A vault holds the memory for one part of your life, such as personal or work. An area is one
        project inside a vault. The area button at the top shows where you are. Press <Kbd>⌘O</Kbd>{" "}
        to switch.
      </p>
      <h2>Where the data comes from</h2>
      <p>
        The viewer reads the same Kioku database your assistants use. Your vaults file decides which
        folders belong to which vault and area.
      </p>
      <h2>Read-only for now</h2>
      <p>This version only reads. Nothing you do here changes a vault.</p>
    </>
  );
}

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  hint?: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    hint: "On Windows and Linux, use Ctrl instead of ⌘.",
    items: [
      { keys: ["⌘K"], label: "Search notes and commands" },
      { keys: ["⌘O"], label: "Switch area" },
      { keys: ["⌘\\"], label: "Collapse or expand the sidebar" },
      { keys: ["⌘["], label: "Go back" },
    ],
  },
  {
    title: "Search",
    items: [
      { keys: ["↑↓"], label: "Move between results" },
      { keys: ["↵"], label: "Open" },
      { keys: ["⌘↵"], label: "Open in graph" },
      { keys: ["⇥"], label: "Search the whole vault" },
      { keys: ["esc"], label: "Close" },
    ],
  },
  {
    title: "Graph",
    hint: "Scroll to zoom and drag to move. Click a note to see it with its links. For keys, click the graph or tab to it first.",
    items: [
      { keys: ["←", "↑", "↓", "→"], label: "Move around" },
      { keys: ["+"], label: "Zoom in" },
      { keys: ["−"], label: "Zoom out" },
      { keys: ["0"], label: "Show the whole area" },
      { keys: ["↵"], label: "Open the note nearest the centre" },
      { keys: ["esc"], label: "Zoom out one step" },
    ],
  },
  {
    title: "Lists",
    items: [
      { keys: ["↑↓"], label: "Move between rows" },
      { keys: ["Page Up", "Page Down"], label: "Move ten rows" },
      { keys: ["Home", "End"], label: "First or last row" },
      { keys: ["↵"], label: "Open the row" },
    ],
  },
];

function Shortcuts() {
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2>{group.title}</h2>
          {group.hint !== undefined && <p className="k-hint">{group.hint}</p>}
          <dl className="k-guide-keys">
            {group.items.map((item) => (
              <div key={item.label} className="k-guide-key">
                <dt>{item.label}</dt>
                <dd>
                  {item.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T };

export function errorText(error: unknown): string {
  return toCommandError(error).message;
}

const NOT_CONFIGURED: UpdateStatus = {
  configured: false,
  current: "",
  latest: null,
  available: false,
  checkedAt: null,
};

function WhatsNew() {
  const [load, setLoad] = useState<Load<ReleaseEntry[]>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    Promise.all([listReleaseNotes(), getAppInfo().catch(() => null)])
      .then(([notes, info]) => {
        if (live)
          setLoad({ state: "ready", value: groupReleaseNotes(notes, info?.version ?? null) });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ state: "error", message: errorText(error) });
      });
    return () => {
      live = false;
    };
  }, []);

  if (load.state === "loading") return <p className="k-hint">Loading release notes…</p>;
  if (load.state === "error")
    return <p role="alert">Couldn't load release notes. {load.message}</p>;
  if (load.value.length === 0) return <p className="k-hint">No release notes yet.</p>;
  return (
    <ol className="k-guide-releases">
      {load.value.map((entry) => (
        <li key={entry.version} aria-labelledby={`release-${entry.version}`}>
          <h2 id={`release-${entry.version}`} className="k-guide-release-head">
            <span className="k-guide-tag">v{entry.version}</span>
            {isIsoDate(entry.date) ? (
              <time className="k-guide-date" dateTime={entry.date}>
                {formatReleaseDate(entry.date)}
              </time>
            ) : (
              <span className="k-guide-date">{entry.date ?? "Unreleased"}</span>
            )}
            {entry.isCurrent && <StatusPill tone="active">You're on this version</StatusPill>}
          </h2>
          {entry.title !== "" && <p className="k-guide-release-title">{entry.title}</p>}
          <ul className="k-bullets">
            {entry.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "error"; message: string }
  | { state: "done"; status: UpdateStatus };

export function describeUpdate(status: UpdateStatus): {
  tone: "active" | "finding" | "neutral";
  text: string;
} {
  if (!status.configured || status.latest === null)
    return { tone: "neutral", text: "Updates aren't set up yet." };
  if (status.available) return { tone: "finding", text: `Version ${status.latest} is available.` };
  return { tone: "active", text: "You're up to date." };
}

function Updates() {
  const [info, setInfo] = useState<Load<AppInfo>>({ state: "loading" });
  const [check, setCheck] = useState<Check>({ state: "idle" });
  useEffect(() => {
    let live = true;
    getAppInfo()
      .then((value) => live && setInfo({ state: "ready", value }))
      .catch((error: unknown) => live && setInfo({ state: "error", message: errorText(error) }));
    return () => {
      live = false;
    };
  }, []);

  const checking = check.state === "checking";
  const run = () => {
    if (checking) return;
    setCheck({ state: "checking" });
    checkForUpdates()
      .then((status) => setCheck({ state: "done", status }))
      .catch((error: unknown) => {
        const failure = toCommandError(error);
        setCheck(
          failure.code === "not_implemented"
            ? { state: "done", status: NOT_CONFIGURED }
            : { state: "error", message: failure.message },
        );
      });
  };

  let result: ReactNode = null;
  if (check.state === "done") {
    const d = describeUpdate(check.status);
    result = <StatusPill tone={d.tone}>{d.text}</StatusPill>;
  } else if (check.state === "error") {
    result = <span>Couldn't check. {check.message}</span>;
  }

  return (
    <>
      {info.state === "loading" && <p className="k-hint">Loading…</p>}
      {info.state === "error" && <p role="alert">Couldn't read the app version. {info.message}</p>}
      {info.state === "ready" && (
        <dl className="k-dl">
          <dt>Version</dt>
          <dd>{info.value.version}</dd>
          <dt>Channel</dt>
          <dd>{info.value.channel === "beta" ? "Beta" : "Stable"}</dd>
        </dl>
      )}
      <div className="k-guide-check">
        <Button variant="primary" onClick={run} aria-disabled={checking}>
          {checking ? "Checking…" : "Check for updates"}
        </Button>
        <output aria-live="polite">{result}</output>
      </div>
    </>
  );
}
