import 'server-only';
import path from 'node:path';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';
import { VisualizationError } from './errors';
import { VISUALIZATION_LIMITS } from './types';
import { prepareVisualizationLibraries } from './libraries';

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)?<svg(?:\s|>)/i.test(bytes.toString('utf8', 0, 1024))) return 'image/svg+xml';
  return null;
}

/** Only <img src> workspace assets are inlined. No generic file contents leave the workspace. */
export async function prepareVisualizationHtml(value: unknown, repoRoot: string): Promise<{ html: string; warnings: string[] }> {
  if (typeof value !== 'string' || !value.trim()) throw new VisualizationError('invalid_html', 'Provide a self-contained HTML document.');
  if (Buffer.byteLength(value) > VISUALIZATION_LIMITS.htmlBytes) throw new VisualizationError('html_too_large', 'HTML exceeds 512 KiB.', 413);
  const warnings: string[] = [];
  if (/<script\b[^>]*\btype\s*=\s*(["'])module\1/i.test(value)) throw new VisualizationError('unsupported_script', 'Use classic inline JavaScript and addEventListener for interactive controls.');
  let html = await prepareVisualizationLibraries(value);
  if (/<[^>]+\son[a-z]+\s*=/i.test(value)) warnings.push('Inline event attributes are blocked. Bind controls with addEventListener in an inline script.');
  const replacements = new Map<string, string>();
  const sources = [...value.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)].map(match => match[2]);
  const occurrences = new Map<string, number>();
  for (const source of sources) occurrences.set(source, (occurrences.get(source) ?? 0) + 1);
  let preparedBytes = Buffer.byteLength(html);
  if (new Set(sources).size > 64) throw new VisualizationError('too_many_images', 'Use at most 64 distinct image sources.');
  for (const src of new Set(sources)) {
    if (/^(?:data:|blob:)/i.test(src)) continue;
    if (/^(?:https?:|\/\/)/i.test(src)) {
      warnings.push('A remote image was blocked. Use inline SVG or a workspace image.');
      continue;
    }
    if (!src || /[&#?]/.test(src) || (/^[a-z][a-z\d+.-]*:/i.test(src) && !src.startsWith('file:'))) {
      warnings.push('An unsupported image source was blocked.');
      continue;
    }
    let rel = src;
    if (src.startsWith('file:')) {
      try { rel = decodeURIComponent(new URL(src).pathname); } catch { throw new VisualizationError('invalid_image', 'Invalid workspace image path.'); }
    }
    if (path.isAbsolute(rel)) rel = path.relative(repoRoot, rel);
    let opened;
    try { opened = await openWorkspaceFile(repoRoot, rel, 'read'); } catch {
      throw new VisualizationError('invalid_image', 'A local image must be a regular file inside this workspace.', 403);
    }
    try {
      if (opened.stat.size > VISUALIZATION_LIMITS.imageBytes) throw new VisualizationError('image_too_large', 'A workspace image exceeds 2 MiB.', 413);
      const bytes = await opened.handle.readFile();
      if (bytes.length > VISUALIZATION_LIMITS.imageBytes) throw new VisualizationError('image_too_large', 'A workspace image exceeds 2 MiB.', 413);
      const mime = imageMime(bytes);
      if (!mime) throw new VisualizationError('invalid_image', 'The workspace image has an unsupported image format.');
      const replacement = `data:${mime};base64,${bytes.toString('base64')}`;
      preparedBytes += (Buffer.byteLength(replacement) - Buffer.byteLength(src)) * (occurrences.get(src) ?? 0);
      if (preparedBytes > VISUALIZATION_LIMITS.documentBytes) {
        throw new VisualizationError('document_too_large', 'Prepared HTML exceeds 8 MiB.', 413);
      }
      replacements.set(src, replacement);
    } finally { await opened.handle.close(); }
  }
  html = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi,
    (whole, prefix: string, quote: string, src: string) => replacements.has(src) ? `${prefix}${quote}${replacements.get(src)}${quote}` : whole);
  if (Buffer.byteLength(html) > VISUALIZATION_LIMITS.documentBytes) throw new VisualizationError('document_too_large', 'Prepared HTML exceeds 8 MiB.', 413);
  return { html, warnings: [...new Set(warnings)].slice(0, 8) };
}
