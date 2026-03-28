import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Cortex IDE',
  description: 'Mobile command surface for AI agent orchestration',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Cortex',
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mobileBuildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? 'dev';

  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `
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
