import type { AppInfo, ReleaseNote, UpdateStatus } from "./types";

/**
 * True when the browser preview should act like a Mac that can confirm with Touch ID, so the
 * save flow can be tried without the desktop app: set localStorage
 * "kioku.viewer.mock.touchId" to "1". The vaults mock then "saves" without writing anything.
 */
export function previewTouchId(): boolean {
  try {
    return globalThis.localStorage?.getItem("kioku.viewer.mock.touchId") === "1";
  } catch {
    return false;
  }
}

export const getAppInfo = (): AppInfo => ({
  version: "0.1.0",
  channel: "stable",
  readOnly: !previewTouchId(),
  canAuthenticate: previewTouchId(),
});

export const checkForUpdates = (): UpdateStatus => ({
  configured: false,
  current: "0.1.0",
  latest: null,
  available: false,
  checkedAt: null,
});

/** Matches CHANGELOG.md, which the desktop app reads at build time. */
export const listReleaseNotes = (): ReleaseNote[] => [
  {
    version: "0.1.0",
    date: null,
    title: "First build of the desktop app.",
    changes: [
      "Library, note, graph, health, reflect, vaults and guide pages.",
      "One area button with a search-first area picker (⌘O) and a command palette (⌘K).",
      "A semantic-zoom graph, from the whole area down to a note's neighbourhood.",
      "Visibility with one switch per app, reviewed in plain language before it applies.",
      "Reflect in Manual and Automatic modes.",
      "Light and dark themes from the design tokens, and reduced motion when the system asks.",
      "Visibility changes are saved after Touch ID, or the Mac password, with a backup of the vaults file first; everything else is read-only.",
      "The Vaults page is one access matrix (a row per vault, a column per model provider) with search and filters, so it stays usable with a hundred vaults or more.",
      "App info and release notes in the app; update checks stay off until signing keys exist.",
      "Note types come from each note's source, so a knowledge base's own types show as they are, and the graph colours up to three types you choose per area.",
    ],
  },
];
