# Motion

Motion explains a change; it never decorates. Values live in `index.ts` (JS) and in
`tokens.css` plus `motion.css` (CSS). Keep them in step.

## Durations

| Token | ms | Use |
| --- | --- | --- |
| `press` / `--duration-press` | 120 | Hover, press, focus and toggle feedback |
| `overlay` / `--duration-overlay` | 180 | Dialogs, palette, toasts, panels, the services line, list entry, the sidebar collapsing |
| `view` / `--duration-view` | 240 | Route changes (view transition crossfade and 6px slide) |
| `zoom` / `--duration-zoom` | 650 | The graph camera's semantic zoom |

## Easing

- `standard`, `cubic-bezier(0, 0, 0.2, 1)` (ease-out, as the design tokens say): everything
  except the camera.
- `zoom`, `cubic-bezier(0.2, 0.7, 0.2, 1)`: the graph camera.

## Helpers

- `usePrefersReducedMotion()`: follows `prefers-reduced-motion` live.
- `runViewTransition(update)` / `useViewTransition()`: uses `document.startViewTransition`
  when it exists, otherwise runs the update directly. Under reduced motion it never animates.
  Pass `type` (for example `"route"`) to set `data-transition` on the root element while it
  runs. Only `data-transition="route"` names `.app-main`, so other transitions never
  crossfade the whole pane. `canViewTransition()` says whether it would animate.
- Route changes animate only when the page changes (library filters, guide sections and
  graph focus swap at once). The main pane scrolls to the top on a page change.
- `usePresence(open)`: keeps a panel mounted while it leaves; set `data-presence` on a
  `.motion-panel`. Overlays still use `app/overlay.ts`'s `usePresence`; a merge is pending.
- `.motion-list` plus `staggerStyle(i)`: list items rise in, the stagger capped at 8 items.
- The Library's More types pops its extra type chips up one after another (240 ms each, a
  slight overshoot, the cascade within 320 ms), and Fewer types pops them down last first and
  quicker (180 ms each, within 220 ms) before the row closes. The timing is in
  `pages/library/typePops.ts`.

## Reduced motion

When the person asks for reduced motion, nothing moves: base.css cuts every CSS
animation and transition and their delays, view transitions are skipped, and JS animation (the graph
camera) jumps to its final state. Colour and opacity changes still apply instantly.

## What never animates

- Note text, search results while typing, and counts or badges updating.
- Layout of the reading view, scroll position, and focus moves.
- Anything longer than 650 ms, loops, or motion that repeats without input.
- Errors and warnings: they appear at once.
