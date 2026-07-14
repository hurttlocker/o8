/**
 * Pure classification helpers for the footer dev-server launcher
 * (`/api/panel/ports`). Kept side-effect free so the page/service split and the
 * human label derivation are unit-testable without a live socket scan.
 *
 * `page`    → a listening port that answered a loopback GET with an HTML web
 *             page (2xx text/html, or a redirect a browser would follow). These
 *             are the "local dev servers you can open in a browser."
 * `service` → anything else: JSON APIs, websockets, MCP bridges, TCP daemons,
 *             or a port that never answered the HTTP probe.
 */

export type PortKind = 'page' | 'service';

/** Result of a single loopback HTTP probe against a listening port. */
export interface HttpProbeResult {
  /** An HTTP response came back (vs. connection refused / reset / timeout). */
  reachable: boolean;
  /** HTTP status code, or null when the probe never completed. */
  status: number | null;
  /** Raw `content-type` response header (may be null). */
  contentType: string | null;
}

/**
 * Decide whether a probed port is an openable web page or a background service.
 *
 * A page is a 2xx response carrying `text/html`, OR a redirect (3xx) — web apps
 * routinely bounce `/` to a sub-path and a browser would land on the page,
 * whereas JSON/RPC services answer 2xx-non-html or don't speak HTTP at all.
 */
export function classifyProbe(probe: HttpProbeResult): PortKind {
  if (!probe.reachable || probe.status === null) return 'service';
  const status = probe.status;
  const isRedirect = status >= 300 && status < 400;
  if (isRedirect) return 'page';
  const is2xx = status >= 200 && status < 300;
  const isHtml = (probe.contentType ?? '').toLowerCase().includes('text/html');
  return is2xx && isHtml ? 'page' : 'service';
}

/**
 * Ordered framework/server fingerprints, matched against
 * `"<processName> <fullCommand>"`. First hit wins, so put the specific
 * signatures (next-server, vite) ahead of the generic runtimes.
 */
const LABEL_RULES: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /next-server|\bnext\s+(dev|start)\b|[/\\]next[/\\]dist/i, label: 'Next.js' },
  { match: /\bvite\b/i, label: 'Vite' },
  { match: /webpack-dev-server|\bwebpack\s+serve\b/i, label: 'webpack' },
  { match: /@storybook|\bstorybook\b/i, label: 'Storybook' },
  { match: /\bnuxt\b/i, label: 'Nuxt' },
  { match: /remix\s+vite:dev|\bremix\s+dev\b/i, label: 'Remix' },
  { match: /\bastro\b/i, label: 'Astro' },
  { match: /ng\s+serve|@angular[/\\]cli/i, label: 'Angular' },
  { match: /\bgatsby\b/i, label: 'Gatsby' },
  { match: /\bstreamlit\b/i, label: 'Streamlit' },
  { match: /-m\s+http\.server|SimpleHTTPServer/i, label: 'Python http.server' },
  { match: /\buvicorn\b/i, label: 'Uvicorn' },
  { match: /\bgunicorn\b/i, label: 'Gunicorn' },
  { match: /manage\.py\s+runserver/i, label: 'Django' },
  { match: /\bflask\b/i, label: 'Flask' },
  { match: /\brails\s+server\b|\bpuma\b/i, label: 'Rails' },
  { match: /json-server/i, label: 'json-server' },
  { match: /http-server/i, label: 'http-server' },
  { match: /php\s+-S\b/i, label: 'PHP' },
];

/** Generic runtime → friendly server name, used when no framework matched. */
const PROCESS_FALLBACKS: Readonly<Record<string, string>> = {
  node: 'Dev server',
  'next-server': 'Next.js',
  bun: 'Dev server',
  deno: 'Dev server',
  tsx: 'Dev server',
  python: 'Python server',
  python3: 'Python server',
  ruby: 'Ruby server',
  go: 'Go server',
  java: 'Java server',
  cargo: 'Rust server',
};

/**
 * Derive a human-readable label for a listening port from its owning process
 * name and full command line. Framework fingerprints win; otherwise fall back
 * to a friendly runtime name, then the raw process name.
 */
export function deriveServerLabel(processName: string, command: string | null): string {
  const haystack = `${processName} ${command ?? ''}`;
  for (const rule of LABEL_RULES) {
    if (rule.match.test(haystack)) return rule.label;
  }
  const fallback = PROCESS_FALLBACKS[processName.toLowerCase()];
  if (fallback) return fallback;
  return processName || 'Server';
}
