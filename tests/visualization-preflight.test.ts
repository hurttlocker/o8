import { beforeEach, expect, it, vi } from 'vitest';
import { VisualizationError } from '@/lib/visualizations/errors';
import { VISUALIZATION_LIMITS } from '@/lib/visualizations/types';

vi.mock('@/lib/visualizations/preview', () => ({ previewVisualization: vi.fn() }));
const { previewVisualization } = await import('@/lib/visualizations/preview');
const { checkVisualization } = await import('@/lib/visualizations/preflight');
const preview = vi.mocked(previewVisualization);
function result(diagnostics: string[] = [], overflow = 0) {
  return { image: '', mimeType: 'image/png' as const, width: 728, height: 240, contentHeight: 240, diagnostics,
    layouts: [320, 480, 728, 1024].map(width => ({ width, height: 240, overflow })) };
}
beforeEach(() => { preview.mockReset(); });

it('checks both appearances and reuses only a successful result for the same document', async () => {
  preview.mockResolvedValue(result());
  const html = '<p>Cache receipt</p>';
  const first = await checkVisualization(html);
  expect(first.check.status).toBe('passed'); expect(first.check.layouts).toHaveLength(8);
  expect(preview.mock.calls.map(call => call[1].appearance)).toEqual(['dark', 'light']);
  expect(await checkVisualization(html)).toEqual(first); expect(preview).toHaveBeenCalledTimes(2);
});

it('repairs overflow once and runs every preview again without changing the data', async () => {
  preview.mockImplementation(async html => result(html.includes('data-o8-layout-repair') ? [] : ['Horizontal overflow at 320px: 120px.'], html.includes('data-o8-layout-repair') ? 0 : 120));
  const html = '<div style="width:1024px">Measured 42 tasks</div>';
  const checked = await checkVisualization(html);
  expect(checked.check).toMatchObject({ status: 'passed', repaired: true });
  expect(checked.html).toContain(html); expect(preview).toHaveBeenCalledTimes(4);
  expect(preview.mock.calls.map(call => call[1].appearance)).toEqual(['dark', 'light', 'dark', 'light']);
});

it('refuses script errors and persistent layout failures rather than publishing them', async () => {
  preview.mockResolvedValue(result(['Uncaught Error: missing dataset']));
  await expect(checkVisualization('<p>Broken script</p>')).rejects.toMatchObject({ code: 'visualization_needs_revision', status: 422 });
  expect(preview).toHaveBeenCalledTimes(2);
  preview.mockClear(); preview.mockResolvedValue(result(['Horizontal overflow at 320px: 50px.'], 50));
  await expect(checkVisualization('<p>Persistent overflow</p>')).rejects.toMatchObject({ status: 422 });
  expect(preview).toHaveBeenCalledTimes(4);
});

it('never repairs a near-limit document into a size the reader cannot load', async () => {
  preview.mockResolvedValue(result(['Horizontal overflow at 320px: 50px.'], 50));
  await expect(checkVisualization('x'.repeat(VISUALIZATION_LIMITS.documentBytes - 50))).rejects.toMatchObject({ code: 'document_too_large', status: 413 });
  expect(preview).toHaveBeenCalledTimes(2);
});

it('reports unavailable preview support honestly and does not treat busy previews as success', async () => {
  preview.mockRejectedValue(new VisualizationError('preview_unavailable', 'Chrome is unavailable', 503));
  const html = '<p>Browser optional</p>';
  expect((await checkVisualization(html)).check).toMatchObject({ status: 'unavailable', diagnostics: ['Chrome is unavailable'] });
  await checkVisualization(html); expect(preview).toHaveBeenCalledTimes(2);
  preview.mockRejectedValue(new VisualizationError('preview_busy', 'Retry shortly', 429));
  await expect(checkVisualization('<p>Busy browser</p>')).rejects.toMatchObject({ code: 'preview_busy', status: 429 });
});
