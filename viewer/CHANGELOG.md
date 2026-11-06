# Changelog

All notable changes to Kioku Viewer are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `viewer-vX.Y.Z`.

## [0.1.0] - Unreleased

First build of the desktop app.

### Added

- Library, note, graph, health, reflect, vaults and guide pages.
- One area button with a search-first area picker (⌘O) and a command palette (⌘K).
- A semantic-zoom graph, from the whole area down to a note's neighbourhood.
- Visibility with one switch per app, reviewed in plain language before it applies.
- Reflect in Manual and Automatic modes.
- Light and dark themes from the design tokens, and reduced motion when the system asks.
- Read-only data access: commands that would change a vault return an error.
- App info and release notes in the app; update checks stay off until signing keys exist.
- Note types come from each note's source, so a knowledge base's own types show as they are, and the graph colours up to three types you choose per area.
