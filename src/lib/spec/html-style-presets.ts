// Theme-aware base CSS injected into sandboxed HTML preview iframes.
//
// The iframe is isolated (sandbox="allow-scripts" — no allow-same-origin),
// so CSS variables on the parent document don't cascade in. We render a
// small base stylesheet with INLINED static colors picked from the active
// theme palette and concat it into srcdoc.
//
// Architected for a future per-repo `.o8/spec.css` override: pass an
// `override` string to `getHtmlStylePreset` and it gets appended after the
// base preset. File-loading is intentionally NOT implemented here.

export type HtmlStylePalette = 'light' | 'midnight';

interface PaletteColors {
  bg: string;
  text: string;
  textMuted: string;
  link: string;
  border: string;
  surface: string;
  code: string;
  codeText: string;
}

const PALETTES: Record<HtmlStylePalette, PaletteColors> = {
  light: {
    bg: '#ffffff',
    text: '#0f172a',
    textMuted: '#5b6475',
    link: '#2563eb',
    border: 'rgba(15, 23, 42, 0.08)',
    surface: '#f5f7fb',
    code: '#f1f5f9',
    codeText: '#0f172a',
  },
  midnight: {
    bg: '#1a1e24',
    text: '#e8ecf2',
    textMuted: '#9aa3b2',
    link: '#7aa2ff',
    border: 'rgba(255, 255, 255, 0.08)',
    surface: '#22272e',
    code: '#16191e',
    codeText: '#e8ecf2',
  },
};

export interface HtmlStylePresetOptions {
  theme?: HtmlStylePalette;
  /** Optional `.o8/spec.css` content to append after the base preset.
   *  Intentionally not loaded from disk here — pass it in. */
  override?: string;
}

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

export function getHtmlStylePreset(opts: HtmlStylePresetOptions = {}): string {
  const palette = PALETTES[opts.theme ?? 'light'];
  const base = `
    :root {
      color-scheme: ${opts.theme === 'midnight' ? 'dark' : 'light'};
    }
    html, body {
      margin: 0;
      padding: 0;
      background: ${palette.bg};
      color: ${palette.text};
      font-family: ${UI_FONT};
      font-size: 14px;
      line-height: 1.6;
      letter-spacing: -0.01em;
    }
    body {
      padding: 16px 18px;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: ${UI_FONT};
      letter-spacing: -0.02em;
      color: ${palette.text};
      margin-top: 1.2em;
      margin-bottom: 0.5em;
    }
    p { margin-top: 0; margin-bottom: 0.8em; }
    a { color: ${palette.link}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    small, .muted { color: ${palette.textMuted}; }
    hr { border: 0; border-top: 1px solid ${palette.border}; margin: 1em 0; }
    code, pre {
      font-family: ${MONO_FONT};
      font-size: 12px;
      background: ${palette.code};
      color: ${palette.codeText};
    }
    code { padding: 1px 5px; border-radius: 6px; }
    pre {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid ${palette.border};
      overflow-x: auto;
    }
    blockquote {
      margin: 0.6em 0;
      padding: 6px 10px;
      border-radius: 10px;
      background: ${palette.surface};
      color: ${palette.textMuted};
    }
    button {
      font-family: ${UI_FONT};
      font-size: 13px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid ${palette.border};
      background: ${palette.surface};
      color: ${palette.text};
      cursor: pointer;
    }
    button:hover { background: ${palette.code}; }
    input, textarea, select {
      font-family: ${UI_FONT};
      font-size: 13px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid ${palette.border};
      background: ${palette.bg};
      color: ${palette.text};
    }
    table { border-collapse: collapse; }
    th, td {
      padding: 6px 10px;
      border-bottom: 1px solid ${palette.border};
      text-align: left;
    }
    img, svg, video { max-width: 100%; }
  `;
  return opts.override ? `${base}\n${opts.override}` : base;
}

/**
 * Build a complete srcdoc string for a sandboxed preview iframe.
 *
 * Wraps the user content with the preset CSS plus a small height-reporting
 * script that posts the document height to the parent on load + on
 * ResizeObserver firings. The parent listens for `o8-html-preview-height`
 * postMessages to auto-size the iframe.
 */
export function buildPreviewSrcdoc(content: string, opts: HtmlStylePresetOptions = {}): string {
  const css = getHtmlStylePreset(opts);
  // Channel id lets the parent disambiguate when multiple previews render.
  // The parent injects a unique id by concatenating before sending; here we
  // forward whatever the parent set on window.__o8PreviewId via inline init.
  const heightScript = `
    (function () {
      function report() {
        var h = Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        );
        try { parent.postMessage({ type: 'o8-html-preview-height', height: h }, '*'); } catch (e) {}
      }
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        report();
      } else {
        window.addEventListener('DOMContentLoaded', report);
      }
      window.addEventListener('load', report);
      if (typeof ResizeObserver !== 'undefined') {
        try {
          var ro = new ResizeObserver(function () { report(); });
          if (document.body) ro.observe(document.body);
          if (document.documentElement) ro.observe(document.documentElement);
        } catch (e) {}
      }
      // Fallback poll for the first 2s in case observers miss late layout.
      var n = 0;
      var t = setInterval(function () { report(); if (++n > 8) clearInterval(t); }, 250);
    })();
  `;
  // The preview runs agent-authored HTML in a sandbox="allow-scripts" iframe, so
  // a script in `content` could otherwise fire a BLIND cross-origin POST to a
  // loopback API route (e.g. /api/panel/dev-server → RCE) even without reading
  // the response. A CSP with `connect-src 'none'` + `form-action 'none'` blocks
  // all network egress (fetch/XHR/beacon/WebSocket/forms) while still allowing
  // the preview to render styled HTML with images and run its inline height
  // script. (SECURITY_AUDIT_2026-07-02 §CRIT-2.)
  const csp = previewContentSecurityPolicy({ allowScripts: true });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style></head><body>${content}<script>${heightScript}<\/script></body></html>`;
}

function previewContentSecurityPolicy(options: { allowScripts: boolean }): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    options.allowScripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Add a restrictive CSP to a complete agent-authored HTML document without
 * rewriting its markup. The iframe may keep inline scripts for interactive
 * charts, but no network-capable resource class is available. Standalone blob
 * tabs use the script-free mode because they no longer have iframe sandboxing.
 */
export function hardenPreviewDocument(
  html: string,
  options: { allowScripts?: boolean } = {},
): string {
  const csp = previewContentSecurityPolicy({ allowScripts: options.allowScripts === true });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  // Search a same-length comment-masked copy so an attacker-controlled
  // `<!-- <head> -->` cannot capture the injection while leaving the real head
  // unprotected. Match offsets remain valid against the original document.
  const searchable = html.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));

  const head = /<head(?:\s[^>]*)?>/i.exec(searchable);
  if (head?.index !== undefined) {
    const insertAt = head.index + head[0].length;
    return `${html.slice(0, insertAt)}${meta}${html.slice(insertAt)}`;
  }
  const root = /<html(?:\s[^>]*)?>/i.exec(searchable);
  if (root?.index !== undefined) {
    const insertAt = root.index + root[0].length;
    return `${html.slice(0, insertAt)}<head>${meta}</head>${html.slice(insertAt)}`;
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}
