const BROWSER_PROXY_PATH = '/api/browser/proxy?url=';

export function isLoopbackBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    return (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

export function browserFrameSrc(url: string): string {
  return isLoopbackBrowserUrl(url)
    ? `${BROWSER_PROXY_PATH}${encodeURIComponent(url.replace('0.0.0.0', 'localhost'))}`
    : url;
}

export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(value)) return `http://${value}`;
  return `https://${value}`;
}

export function browserTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return `localhost:${parsed.port || '80'}`;
    }
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url || 'New Tab';
  }
}
