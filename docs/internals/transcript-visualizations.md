# Interactive transcript visualizations

An orchestrator can publish self-contained HTML into its current conversation.
Charts, diagrams, illustrations, tables, and UI comparisons stay interactive in
the transcript and can open in a larger workspace tab.

## Requesting a visual

Use `/visualization <what to show>` or its `/visualize` alias in the orchestrator
composer. The command keeps the selected backend, model, effort, conversation,
and supplied attachments. It requests an inline explanation rather than a fleet
dispatch. Natural requests such as “show me a visualization” or “illustrate this
flow” are also taught in the shared orchestrator prompt.

Claude Code, Codex, the managed orchestrator, and connected ACP and gateway leads
receive the same MCP tool descriptions. ACP sessions also carry current-thread
defaults; gateway leads receive an explicit target in their turn instructions.
Solo and proposer profiles receive a separate display-only server;
they do not gain dispatch or workspace mutation authority. Runtime sessions that
deliberately launch without MCP do not have these tools.

## Authoring loop

1. Build inline CSS, classic JavaScript, SVG or canvas, and optional images.
2. Call `o8_html_preview` and inspect its PNG and diagnostics. Check the reply
   width, a narrow width, and light and dark appearances.
3. Fix overlap, stretched labels, low contrast, clipped details, and chart scales.
4. Call `o8_html_render` before the final reply. Its reference is displayed inline.
   The reply should add interpretation without repeating the HTML or the data.

The tools include shared design guidance from `src/lib/visualizations/design.ts`.
Use theme variables rather than fixed page backgrounds. The frame supplies system
typography, tabular numbers, focus outlines, reduced motion, live theme updates,
and natural content height. `--popover` provides a readable tooltip surface.
ResizeObserver-driven SVG viewBoxes keep labels and strokes the same size as the
container changes. Accessible values and units belong beside the graphic.

## Shared toolkit

Every visualization receives `d3` 7.9.0 and `o8Viz` version 3. The D3 application
chunk loads when a visual mounts. Shared line and grouped bar charts handle axes,
tick collisions, missing values, series legends, pointer-following cross-series
details, touch pinning, keyboard exploration, and a semantic values table.
Use D3 directly for other layouts or plots; keep data embedded in the document.

```html
<div id="activity"></div>
<script>
const chart = o8Viz.chart('#activity', {
  type: 'line', xLabel: 'Day', yLabel: 'Tasks',
  series: [{ id: 'tasks', label: 'Tasks', values: [{ x: 1, y: 4 }, { x: 2, y: 7 }] }]
});
</script>
```

`chart.update(options, { animate: true, keyboard: false })` updates an existing
chart. Keyboard changes and reduced-motion preferences apply immediately.
Interpolation is labeled approximate; null values do not create a connecting line.
Shared `.viz-*` controls, tabs, tables and tooltip surfaces use the live o8 theme.
`data-viz-tabs` groups emit `viz:change` and persist their `data-state-key` choice.
`o8Viz.getState()` / `setState(object)` remember small presentation choices in the
reader's local storage, scoped to the immutable visual. `onState(callback)` keeps
inline and expanded views in sync. Snapshots are bounded to 16 KiB and are never
sent to a provider. `o8Viz.ask(question)` offers a draft question through host UI;
the reader adds it to the composer and sends it themselves.

Preview checks narrow, medium, requested and wide widths in the same isolated
browser and reports measured heights and horizontal overflow beside the PNG.

## Optional libraries

Pinned Chart.js 4.5.1 and ECharts 6.1.0 script URLs are listed in the MCP guide.
They download only when a document explicitly requests one. The server refuses
redirects, caps downloads, verifies the exact SHA-256 and caches the reviewed
build. A saved document contains its inline copy, so viewing it needs no CDN.
An unavailable library returns a clear retry or bundled-toolkit fallback message.
Unknown URLs, versions and dynamic imports are refused. Adding a library requires
a catalog change with its reviewed build, version, size, hash and license.

## Storage and isolation

Documents are immutable SQLite records bound to a registered workspace and either
an orchestrator thread or a worker packet. Metadata polling recovers saved visuals
even when a runtime omits structured tool output. Completed worker transcripts
retain their visuals. Document bodies are fetched as authenticated JSON and never
served as executable HTML on the application origin.

Two opaque sandboxed frames separate agent content from both the application and
the trusted message bridge. CSP blocks external resources and navigation. Inline
scripts are hashed together with an irreversible WebRTC guard; inherited hashes
prevent fresh child frames from executing unguarded scripts. The app's own WebRTC
features are unaffected. The preview uses a separate unauthenticated browser,
blocks network and downloads, and closes after each call.

Bind controls with `addEventListener`; module scripts and inline event attributes
are unsupported. Approved library requests are resolved before sandboxing;
remote fonts and runtime network requests are blocked. Workspace `<img src>` files are
opened through confined descriptors, verified as images, and inlined. References
outside the caller's workspace are refused.

HTML is limited to 512 KiB, preview widths to 320–1600 pixels, and initial heights
to 80–1800 pixels. Preview requires installed Chrome or Chromium. Rendering and
viewing saved documents continue to work when a preview browser is unavailable.
