/** Shared authoring guidance, independent of the model or orchestrator backend. */
export const VISUALIZATION_DESIGN_GUIDE = [
  'Design for understanding: one clear visual hierarchy, generous spacing, restrained color, and compact controls.',
  'Use the system font: body 13px weight 300, labels 11px, headings 18px weight 400. Use tabular numbers; align comparable values.',
  'Charts need labeled axes, units, honest scales, 3–5 faint grid lines, and consistent series colors. Prefer 2px round strokes and subtle area fills.',
  'For continuous data, monotone curves may soften a line without overshooting values; keep discrete events discrete. Never invent points or smooth away missing data.',
  'Keep chart heights around 220–280px. Measure the container width with ResizeObserver and match the SVG viewBox so labels and strokes do not stretch.',
  'Hover details should follow the pointer, stay inside the visual, and show aligned labels and values. Keyboard focus or touch must expose the same information.',
  'Use --popover for readable tooltip surfaces, --muted-foreground for secondary labels, and --chart-1 through --chart-6 consistently. Do not rely on color alone.',
  'Diagrams need short labels, consistent node sizes, clear connections, and a focused detail view rather than crowded paragraphs inside nodes.',
  'Controls respond immediately. Use at most 160ms for optional pointer feedback; no looping decoration, animated chart reveals, or delayed keyboard actions.',
  'Include an accessible table or textual equivalent for chart values. Label illustrative data explicitly, and distinguish estimates from measured values.',
  'Check at the reply width and 320px, in light and dark appearances. Fix overlapping labels, clipped details, stretched geometry, and low contrast before rendering.',
].join(' ');
