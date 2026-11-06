import type { AppInfo, ReleaseNote, UpdateStatus } from "./types";

export const getAppInfo = (): AppInfo => ({
  version: "0.1.0",
  channel: "stable",
  readOnly: true,
  canAuthenticate: false,
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
      "Read-only data access: commands that would change a vault return an error.",
      "App info and release notes in the app; update checks stay off until signing keys exist.",
    ],
  },
];
