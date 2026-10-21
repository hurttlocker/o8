const SUMMARY_CACHE_KEY = 'o8:update-card:summary'; // per-version map

export function readCachedSummary(version: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return typeof map[version] === 'string' ? map[version] : null;
  } catch {
    return null;
  }
}

export function writeCachedSummary(version: string, summary: string) {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    const map = raw ? JSON.parse(raw) as Record<string, string> : {};
    map[version] = summary;
    window.localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}
