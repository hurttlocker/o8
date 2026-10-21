import 'server-only';
import { createHash } from 'node:crypto';
import { previewVisualization } from './preview';
import { VisualizationError } from './errors';
import { VISUALIZATION_LIMITS } from './types';

export interface VisualizationCheck {
  status: 'passed' | 'unavailable';
  repaired: boolean;
  layouts: Array<{ appearance: string; width: number; height: number; overflow: number }>;
  diagnostics: string[];
}
const cache = new Map<string, { html: string; check: VisualizationCheck }>();
const repair = '<style data-o8-layout-repair>body{max-width:100%;min-width:0}body *{max-width:100%;min-width:0;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{table-layout:fixed}img{height:auto}</style>';

/** One bounded layout repair, then actionable feedback. No provider calls. */
export async function checkVisualization(html: string): Promise<{ html: string; check: VisualizationCheck }> {
  if (Buffer.byteLength(html, 'utf8') > VISUALIZATION_LIMITS.documentBytes) throw new VisualizationError('document_too_large', 'Visualization document exceeds 8 MiB.', 413);
  const key = createHash('sha256').update('o8-layout-v4:').update(html).digest('hex');
  const cached = cache.get(key);
  if (cached) return cached;
  let candidate = html;
  for (let attempt = 0; attempt < 2; attempt++) {
    const layouts: VisualizationCheck['layouts'] = [], diagnostics: string[] = [];
    try {
      for (const appearance of ['dark', 'light'] as const) {
        const preview = await previewVisualization(candidate, { width: 728, appearance });
        layouts.push(...preview.layouts.map(layout => ({ appearance, ...layout })));
        diagnostics.push(...preview.diagnostics.map(message => `${appearance}: ${message}`));
      }
    } catch (error) {
      if (error instanceof VisualizationError && error.code === 'preview_unavailable') return { html: candidate,
        check: { status: 'unavailable', repaired: false, layouts, diagnostics: [error.message] } };
      throw error;
    }
    if (!diagnostics.length && layouts.every(layout => layout.overflow <= 1)) {
      const result = { html: candidate, check: { status: 'passed' as const, repaired: attempt > 0, layouts, diagnostics } };
      // Cache only short successful documents; do not retain large library copies.
      if (Buffer.byteLength(candidate, 'utf8') < 128 * 1024) { cache.set(key, result); if (cache.size > 16) cache.delete(cache.keys().next().value!); }
      return result;
    }
    const overflowOnly = diagnostics.every(message => message.includes('Horizontal overflow at'));
    if (!attempt && overflowOnly && !candidate.includes('data-o8-layout-repair')) {
      if (Buffer.byteLength(candidate + repair, 'utf8') > VISUALIZATION_LIMITS.documentBytes) throw new VisualizationError('document_too_large', 'The layout repair would exceed the 8 MiB document limit. Reduce the document and retry.', 413);
      candidate += repair;
      continue;
    }
    throw new VisualizationError('visualization_needs_revision', `The visual was not published. Fix these preview checks and retry: ${diagnostics.slice(0, 6).join(' ') || 'Horizontal overflow.'}`, 422);
  }
  throw new VisualizationError('visualization_needs_revision', 'Refine the layout and retry.', 422);
}
