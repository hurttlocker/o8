'use client';

import { useEffect } from 'react';
import { BROWSER_OPEN_REQUEST_EVENT } from '@/lib/browser/open-request';

export function useBrowserOpenRequests(openBrowser: (url?: string) => void, scopeKey: string) {
  useEffect(() => {
    const receive = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
      if (typeof requestId !== 'string') return;
      const request = window.__o8BrowserOpenRequests?.get(requestId);
      if (!request || request.accepted || request.error) return;
      request.accepted = true;
      request.scopeKey = scopeKey;
      try {
        openBrowser(request.url ?? undefined);
        if (request.url) window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: request.url, scopeKey } }));
      }
      catch (error) { request.error = error instanceof Error ? error.message : 'Browser host failed'; }
    };
    window.addEventListener(BROWSER_OPEN_REQUEST_EVENT, receive);
    return () => window.removeEventListener(BROWSER_OPEN_REQUEST_EVENT, receive);
  }, [openBrowser, scopeKey]);
}
