/** Shared controls live inside the visualization sandbox, never in application chrome. */
export const VISUALIZATION_STYLES = `
  :root { --viz-gap: 16px; --viz-control-height: 28px; }
  [hidden] { display:none !important; }
  .viz-row, .viz-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .viz-controls { margin:14px 0; }
  .viz-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:20px; }
  .viz-heading { margin:0 0 16px; font-size:18px; font-weight:400; letter-spacing:-.2px; }
  .viz-caption { color:var(--muted-foreground); font-size:11px; line-height:1.5; }
  .viz-value { font-size:28px; line-height:1.2; font-weight:400; letter-spacing:-.5px; font-variant-numeric:tabular-nums; }
  .viz-button, .viz-tabs button, .viz-controls select, .viz-controls input:not([type=range]) {
    min-height:var(--viz-control-height); border:0; border-radius:7px; padding:5px 10px;
    background:var(--muted); color:var(--foreground); font:300 12px/1.3 var(--font-sans); letter-spacing:-.1px;
  }
  .viz-button { cursor:pointer; }
  .viz-button[data-variant=ghost] { background:transparent; color:var(--muted-foreground); }
  .viz-button[data-variant=primary] { background:var(--primary); color:var(--primary-foreground); }
  .viz-button:disabled { opacity:.4; cursor:default; }
  .viz-tabs { display:inline-flex; flex-wrap:wrap; gap:3px; padding:3px; border-radius:9px; background:var(--muted); }
  .viz-tabs button { background:transparent; color:var(--muted-foreground); cursor:pointer; }
  .viz-tabs button[aria-selected=true] { background:var(--card); color:var(--foreground); }
  .viz-controls label { display:grid; gap:6px; font-size:11px; color:var(--muted-foreground); }
  .viz-controls input[type=range] { accent-color:var(--accent); min-height:28px; max-width:100%; }
  .viz-table { width:100%; border-collapse:collapse; font-size:12px; }
  .viz-table th { text-align:left; color:var(--muted-foreground); font-weight:300; }
  .viz-table th, .viz-table td { padding:9px 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
  .viz-table td[data-numeric], .viz-table th[data-numeric] { text-align:right; font-variant-numeric:tabular-nums; }
  .viz-table-wrap { overflow-x:auto; scrollbar-width:none; }
  .viz-details { margin-top:14px; color:var(--muted-foreground); font-size:11px; }
  .viz-details summary { cursor:pointer; width:fit-content; padding:6px 0; }
  .viz-details[open] summary { margin-bottom:6px; }
  .viz-tooltip { position:absolute; z-index:3; pointer-events:none; box-sizing:border-box; max-width:min(280px,100%);
    padding:11px 13px; border:1px solid var(--border); border-radius:12px; background:var(--popover);
    color:var(--foreground); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
    box-shadow:0 8px 24px color-mix(in srgb,var(--foreground) 8%,transparent); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .viz-tooltip-title { margin-bottom:7px; font-size:11px; color:var(--muted-foreground); }
  .viz-tooltip-row { display:flex; justify-content:space-between; align-items:center; gap:20px; }
  .viz-tooltip-label { display:flex; align-items:center; gap:7px; min-width:0; }
  .viz-tooltip-value { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .viz-swatch { display:inline-block; width:8px; height:8px; border-radius:2px; flex:none; }
  .viz-chart { position:relative; min-width:0; margin:0; }
  .viz-chart svg { display:block; width:100%; overflow:visible; }
  .viz-chart text { fill:var(--muted-foreground); font:300 11px var(--font-sans); }
  .viz-chart .domain { stroke:var(--border); }
  .viz-chart .tick line { stroke:var(--border); }
  .viz-chart-legend { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:12px; }
  .viz-chart-legend button { display:inline-flex; align-items:center; gap:7px; background:none; border:0; padding:4px 0;
    color:var(--foreground); font:300 12px var(--font-sans); cursor:pointer; }
  .viz-chart-legend button[aria-pressed=false] { color:var(--muted-foreground); opacity:.55; }
  .viz-chart-description { margin-top:6px; min-height:17px; font-size:11px; color:var(--muted-foreground); }
  .viz-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
  .viz-dashboard { min-width:0; }
  .viz-dashboard .viz-controls { justify-content:space-between; }
  .viz-dashboard .viz-grid { margin:22px 0; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .viz-dashboard .viz-button { display:inline-flex; align-items:center; gap:7px; }
  .viz-dashboard button[aria-pressed=true] { background:var(--card); color:var(--foreground); }
  .viz-dashboard[data-density=compact] .viz-grid { margin:12px 0; gap:12px; }
  .viz-dashboard[data-density=compact] .viz-value { font-size:24px; }
  .viz-selection { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin:8px 0; }
  .viz-heatmap { position:relative; margin:20px 0; }
  .viz-heat-grid { display:grid; gap:4px; width:100%; min-width:max-content; align-items:center; }
  .viz-heat-grid > .viz-caption { font-size:10px; white-space:nowrap; overflow:hidden; }
  .viz-heat-cell { width:100%; min-width:16px; min-height:22px; border:0; border-radius:3px; padding:0; cursor:pointer; }
  .viz-heat-cell[data-selected=false] { opacity:.25; }
  .viz-heat-cell[aria-pressed=true] { outline:1px solid var(--foreground); outline-offset:1px; }
  .viz-detail { margin:18px 0; padding:14px 0; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .viz-detail h3 { margin:0 0 7px; }
  .viz-dashboard > [data-viz-source] { margin-top:20px; }
  @media (pointer:coarse) { .viz-heat-cell { min-height:32px; min-width:32px; } }
  @media (hover:hover) and (pointer:fine) {
    .viz-button:hover:not(:disabled), .viz-tabs button:hover { background:var(--secondary,var(--muted)); color:var(--foreground); }
    .viz-chart-legend button:hover { opacity:1; }
  }
  @media (pointer:coarse) {
    :root { --viz-control-height:44px; }
    .viz-chart-legend button { min-height:44px; }
    .viz-controls input, .viz-controls select { font-size:16px; }
  }
  @media (prefers-reduced-transparency:reduce), (prefers-contrast:more) {
    .viz-tooltip { background:var(--card); backdrop-filter:none; -webkit-backdrop-filter:none; }
  }
`;
