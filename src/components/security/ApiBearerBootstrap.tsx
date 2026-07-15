type ApiBearerBootstrapProps = {
  source: 'meta' | 'mobile';
};

const SCRIPT_BY_SOURCE: Record<ApiBearerBootstrapProps['source'], string> = {
  meta: `
    (function () {
      if (window.__o8ApiBearerInstalled) return;
      window.__o8ApiBearerInstalled = true;
      var nativeFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          var token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') || '';
          var url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
          if (token && url.origin === window.location.origin && url.pathname.indexOf('/api/') === 0) {
            var headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
            if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
            init = Object.assign({}, init, { headers: headers });
          }
        } catch (error) {}
        return nativeFetch(input, init);
      };
    })();
  `,
  mobile: `
    (function () {
      if (window.__o8ApiBearerInstalled) return;
      window.__o8ApiBearerInstalled = true;
      var nativeFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          var match = window.location.hash.match(/[#&]tk=([^&]+)/);
          var token = match && match[1] ? decodeURIComponent(match[1]) : '';
          if (!token) token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') || '';
          if (!token) token = window.localStorage.getItem('o8:mobile-ws-token') || '';
          var url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
          if (token && url.origin === window.location.origin && url.pathname.indexOf('/api/') === 0) {
            var headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
            if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
            init = Object.assign({}, init, { headers: headers });
          }
        } catch (error) {}
        return nativeFetch(input, init);
      };
    })();
  `,
};

/** Install API bearer attachment before client hydration starts. */
export function ApiBearerBootstrap({ source }: ApiBearerBootstrapProps) {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT_BY_SOURCE[source] }} />;
}
