import './globals.css';
import type { Metadata, Viewport } from 'next';
import { resolvePortInfo } from '@/lib/panel/api-port';
import NavigationBridge from '@/components/NavigationBridge';
import { O8AuthProvider } from '@/components/auth/O8AuthProvider';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';
import { headers } from 'next/headers';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const metadata: Metadata = {
  title: 'o8',
  description: 'Mobile command surface for AI agent orchestration',
  other: {
    'theme-color': '#1C1C1E',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mobileBuildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? 'dev';

  // Resolve the ws-server port on the server so we can inject it into the
  // page before any client code runs. This lets browser hooks read
  // window.__O8_WS_PORT__ instead of hardcoding 3002. See
  // src/lib/panel/ws-port-client.ts for the reader.
  const { wsPort } = resolvePortInfo();
  const requestHeaders = await headers();
  const isLocal = headersIndicateLoopback((name) => requestHeaders.get(name));
  const operatorToken = isLocal ? getOrCreateWsToken() : '';

  return (
    <html lang="en" style={{ background: '#1C1C1E' }} suppressHydrationWarning>
      <head>
        {operatorToken ? <meta name="ws-token" content={operatorToken} /> : null}
        {/* Pre-paint theme stamp — mirrors ThemeProvider's persisted-theme
            resolution (src/lib/theme/context.tsx: readPaletteId /
            readReduceTransparency / resolveSurface) so data-palette /
            data-surface are truthful BEFORE first paint. The boot cover
            (--o8-boot-cover-* in globals.css) and all pre-hydration chrome
            key off these attrs; without this, a dark-palette user paints a
            light shell until the ThemeProvider effect runs. Keep the three
            storage keys + fallbacks in sync with context.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var ls = window.localStorage;
                  var pal = ls.getItem('cortex-theme-palette');
                  var legacy = ls.getItem('cortex-theme');
                  var rt = ls.getItem('cortex-reduce-transparency');
                  var hasPref = pal !== null || legacy !== null || rt !== null;
                  if (pal !== 'light' && pal !== 'dark') {
                    var remap = { light: 'light', midnight: 'dark', dark: 'dark', chocolate: 'dark' };
                    pal = (legacy && remap[legacy]) || (hasPref ? 'dark' : 'light');
                  }
                  if (rt !== 'on' && rt !== 'off' && rt !== 'system') {
                    rt = hasPref ? 'system' : 'on';
                  }
                  var surface = rt === 'on' ? 'solid' : 'glass';
                  // ALL GLASS mode overrides both axes wholesale (mirrors
                  // effectiveSurface / getPalette('dark') in context.tsx:
                  // workspace glass forces the dark-glass theme regardless of
                  // the stored palette/transparency prefs). Missing this
                  // painted a cream cover under a dark-glass boot.
                  if (ls.getItem('cortex-workspace-glass') === 'true') {
                    pal = 'dark';
                    surface = 'glass';
                  }
                  var el = document.documentElement;
                  el.dataset.theme = pal;
                  el.dataset.palette = pal;
                  el.dataset.surface = surface;
                  // Inline cover vars — the boot cover must paint the right
                  // theme even BEFORE the stylesheet applies (the packaged
                  // webview painted the inline cream fallback for ~1s on a
                  // dark-glass machine, a cream blink between the dark native
                  // splash and the dark cover). Values mirror the
                  // --o8-boot-cover-* block in globals.css.
                  var coverBg = surface === 'glass'
                    ? 'linear-gradient(180deg, rgb(32, 36, 42) 0%, rgb(18, 20, 24) 100%)'
                    : (pal === 'dark' ? '#242424' : '#F4F2ED');
                  var coverInk = surface === 'glass'
                    ? 'rgba(244, 244, 245, 0.5)'
                    : (pal === 'dark' ? 'rgba(232, 236, 242, 0.45)' : 'rgba(15, 23, 42, 0.45)');
                  el.style.setProperty('--o8-boot-cover-bg', coverBg);
                  el.style.setProperty('--o8-boot-cover-ink', coverInk);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body style={{ background: '#1C1C1E', margin: 0, fontFamily: 'var(--font-sans-system)' }} suppressHydrationWarning>
        {operatorToken ? <ApiBearerBootstrap source="meta" /> : null}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.__O8_WS_PORT__ = ${JSON.stringify(wsPort)};
              if (window.__TAURI_INTERNALS__) {
                document.documentElement.dataset.tauri = 'true';
                if (document.body) {
                  document.body.dataset.tauri = 'true';
                }
              }
            `,
          }}
        />
        <NavigationBridge />
        {/* UpdateBanner removed — the inline UpdateCard renders inside
            AgentPanel above the chrome icons (o8/AgentPanel.tsx).
            That stops it from covering the workspace tab strip + reconnect
            banner when an update lands. */}
        <O8AuthProvider>{children}</O8AuthProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator && !window.__TAURI_INTERNALS__) {
                window.addEventListener('load', function() {
                  var buildRevision = ${JSON.stringify(mobileBuildRevision)};
                  var reloadMarker = 'cortex.mobile.asset-reset:' + buildRevision;
                  var buildMarker = 'cortex.mobile.build-revision';

                  Promise.all([
                    navigator.serviceWorker.getRegistrations()
                      .then(function(registrations) {
                        // Preserve sw-push.js — it's the push notification SW
                        // (issue #639) and isn't part of the asset-cache reset.
                        var doomed = registrations.filter(function(registration) {
                          var url = registration.active && registration.active.scriptURL || '';
                          return url.indexOf('sw-push.js') === -1;
                        });
                        return Promise.all(doomed.map(function(registration) {
                          return registration.unregister();
                        })).then(function(results) {
                          return results.some(Boolean);
                        });
                      })
                      .catch(function() { return false; }),
                    'caches' in window
                      ? caches.keys()
                        .then(function(keys) {
                          var targetKeys = keys.filter(function(key) { return key.indexOf('cortex-ide-') === 0; });
                          return Promise.all(targetKeys.map(function(key) { return caches.delete(key); }))
                            .then(function(results) { return targetKeys.length > 0 && results.some(Boolean); });
                        })
                        .catch(function() { return false; })
                      : Promise.resolve(false),
                  ]).then(function(results) {
                    var hadServiceWorkers = results[0];
                    var hadCaches = results[1];
                    var previousBuild = null;

                    try {
                      previousBuild = window.localStorage.getItem(buildMarker);
                      window.localStorage.setItem(buildMarker, buildRevision);
                    } catch (error) {}

                    var buildChanged = Boolean(previousBuild && previousBuild !== buildRevision);
                    var shouldReload = !window.sessionStorage.getItem(reloadMarker) && (hadServiceWorkers || hadCaches || buildChanged);
                    console.info('[mobile] asset cleanup', {
                      buildRevision: buildRevision,
                      previousBuild: previousBuild,
                      hadServiceWorkers: hadServiceWorkers,
                      hadCaches: hadCaches,
                      buildChanged: buildChanged,
                      shouldReload: shouldReload,
                    });

                    if (!shouldReload) return;
                    window.sessionStorage.setItem(reloadMarker, '1');
                    var url = new URL(window.location.href);
                    url.searchParams.set('_mobileReload', buildRevision);
                    window.location.replace(url.toString());
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
