import './globals.css';
import type { Metadata, Viewport } from 'next';
import { resolvePortInfo } from '@/lib/panel/api-port';

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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mobileBuildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? 'dev';

  // Resolve the ws-server port on the server so we can inject it into the
  // page before any client code runs. This lets browser hooks read
  // window.__O8_WS_PORT__ instead of hardcoding 3002. See
  // src/lib/panel/ws-port-client.ts for the reader.
  const { wsPort } = resolvePortInfo();

  return (
    <html lang="en" style={{ background: '#1C1C1E' }} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,200;0,300;0,400;0,500;0,600;0,700;0,800;1,200;1,300;1,400;1,500;1,600;1,700;1,800&display=swap" />
      </head>
      <body style={{ background: '#1C1C1E', margin: 0, fontFamily: '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }} suppressHydrationWarning>
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
        {children}
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
                        return Promise.all(registrations.map(function(registration) {
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
