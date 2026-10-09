import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { VisualizationError } from './errors';
import { VISUALIZATION_LIBRARIES, type VisualizationLibrary } from './library-catalog';
import { VISUALIZATION_LIMITS } from './types';
import { CHARTJS_LICENSE, ECHARTS_LICENSE } from './vendor/license-notices';

const pending = new Map<string, Promise<string>>();
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024;

function verified(bytes: Uint8Array, library: VisualizationLibrary): boolean {
  return bytes.byteLength === library.bytes && createHash('sha256').update(bytes).digest('hex') === library.sha256;
}

/** A fixed URL, bounded body, no redirects or caller credentials, and exact content hash. */
async function download(library: VisualizationLibrary): Promise<Buffer> {
  const response = await fetch(library.url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_LIBRARY_BYTES) {
    throw new Error('Library download failed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_LIBRARY_BYTES) { await reader.cancel(); throw new Error('Library is too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (!verified(bytes, library)) throw new Error('Library checksum did not match');
  return bytes;
}

async function cachedLibrary(library: VisualizationLibrary): Promise<string> {
  if (library.bundled) return (await import('./vendor/d3')).D3_SOURCE;
  const directory = join(getDataDir(), 'cache', 'visualization-libraries');
  const key = join(directory, `${library.id}-${library.version}-${library.sha256}.js`);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = (async () => {
    try {
      const cached = await readFile(key);
      if (verified(cached, library)) return cached.toString('utf8');
    } catch { /* A cold cache downloads exactly one reviewed build. */ }
    const bytes = await download(library);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${key}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, key);
    return bytes.toString('utf8');
  })();
  pending.set(key, work);
  try { return await work; } catch (error) { pending.delete(key); throw error; }
}

/** Approved script requests become immutable inline copies before entering the sandbox. */
export async function prepareVisualizationLibraries(html: string): Promise<string> {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length > 64) throw new VisualizationError('too_many_scripts', 'Use at most 64 script blocks. Load each library once.');
  const replacements: Array<{ start: number; end: number; html: string }> = [];
  const loaded = new Set<string>();
  let size = Buffer.byteLength(html);
  for (const match of scripts) {
    const source = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!source) continue;
    const url = source[1] ?? source[2] ?? source[3];
    const library = VISUALIZATION_LIBRARIES.find(entry => entry.url === url);
    if (!library) throw new VisualizationError('unsupported_library', 'Use bundled d3/o8Viz, or a pinned library URL from the visualization guide. Arbitrary library URLs are not supported.');
    try {
      // D3 is already injected by the common runtime; do not execute it twice.
      const first = !loaded.has(library.id);
      if (first && !library.bundled) size += library.bytes;
      if (size > VISUALIZATION_LIMITS.documentBytes) throw new VisualizationError('document_too_large', 'Prepared HTML exceeds 8 MiB.', 413);
      const notice = library.id === 'chartjs' ? CHARTJS_LICENSE : ECHARTS_LICENSE;
      const body = library.bundled || !first ? '' : (`/* ${notice} */\n${await cachedLibrary(library)}`).replace(/<\/script/gi, '<\\/script');
      loaded.add(library.id);
      replacements.push({ start: match.index!, end: match.index! + match[0].length,
        html: `<script data-o8-library="${library.id}" data-version="${library.version}">${body}</script>` });
    } catch (error) {
      if (error instanceof VisualizationError) throw error;
      throw new VisualizationError('library_unavailable', `${library.name} ${library.version} could not be downloaded and verified. Retry, or use bundled d3/o8Viz.`, 503);
    }
  }
  for (const replacement of replacements.reverse()) html = html.slice(0, replacement.start) + replacement.html + html.slice(replacement.end);
  return html;
}
