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
are unsupported. External chart libraries and remote fonts are blocked. Inline
SVG and canvas work without a chart dependency. Workspace `<img src>` files are
opened through confined descriptors, verified as images, and inlined. References
outside the caller's workspace are refused.

HTML is limited to 512 KiB, preview widths to 320–1600 pixels, and initial heights
to 80–1800 pixels. Preview requires installed Chrome or Chromium. Rendering and
viewing saved documents continue to work when a preview browser is unavailable.
