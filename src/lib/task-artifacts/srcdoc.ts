import { TASK_ARTIFACT_FRAME_BOOTSTRAP } from './bridge-protocol';

/**
 * Content-Security-Policy for the artifact document. The iframe already runs
 * with `sandbox="allow-scripts"` (no same-origin, no forms, no popups, no top
 * navigation), which removes cookies, storage, and the host DOM. The CSP closes
 * the remaining hole: a script inside the frame could still fire a blind
 * cross-origin request. `connect-src 'none'` plus `form-action 'none'` blocks
 * fetch, XHR, beacons, WebSockets, and form posts; images, fonts, and media are
 * limited to inline data. Mirrors the static HTML preview policy.
 */
export const TASK_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "navigate-to 'none'",
].join('; ');

export interface TaskArtifactSrcdocTheme {
  background: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  fontFamily: string;
}

/**
 * The frame gets a small, explicit palette as CSS custom properties. It has no
 * way to read the host's theme tokens on its own, and it should not need one.
 */
function themeCss(theme: TaskArtifactSrcdocTheme): string {
  return `:root{--o8-bg:${theme.background};--o8-text:${theme.text};--o8-text-muted:${theme.textMuted};--o8-border:${theme.border};--o8-accent:${theme.accent};--o8-font:${theme.fontFamily};color-scheme:light dark}` +
    'html,body{margin:0;background:var(--o8-bg);color:var(--o8-text);font-family:var(--o8-font);font-size:13px;line-height:1.45}';
}

function stripLeadingDoctype(html: string): string {
  return html.replace(/^\s*<!doctype[^>]*>/i, '');
}

/**
 * Build the complete document for the sandboxed iframe. The agent's HTML is
 * embedded verbatim after the CSP meta, the palette, and the bridge bootstrap,
 * so `window.o8` exists before any agent script runs.
 */
export function buildTaskArtifactSrcdoc(html: string, theme: TaskArtifactSrcdocTheme): string {
  const body = stripLeadingDoctype(html);
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${TASK_ARTIFACT_CSP}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${themeCss(theme)}</style>`
    + `<script>${TASK_ARTIFACT_FRAME_BOOTSTRAP}</script>`
    + `</head><body>${body}</body></html>`;
}
