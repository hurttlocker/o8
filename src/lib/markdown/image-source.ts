/** Resolve presentation URLs without changing the document's original source. */
export function markdownImageSource(src: string, filePath: string, repoPath: string | null): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) return src;
  const path = src.split(/[?#]/, 1)[0];
  if (!path) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  const directory = filePath.slice(0, filePath.lastIndexOf('/') + 1);
  const params = new URLSearchParams({ path: decoded.startsWith('/') ? decoded : directory + decoded });
  if (repoPath) params.set('workspace', repoPath);
  const fragment = src.includes('#') ? src.slice(src.indexOf('#')) : '';
  return `/api/panel/file-asset?${params.toString()}${fragment}`;
}
