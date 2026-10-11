import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '', source: 'window.fixtureChart = true;', sha: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.directory }));
vi.mock('@/lib/visualizations/library-catalog', () => ({ VISUALIZATION_LIBRARIES: [
  { id: 'chartjs', name: 'Chart.js', version: 'fixture', bundled: false, url: 'https://cdn.jsdelivr.net/npm/chart.js@fixture/dist/chart.umd.min.js',
    get bytes() { return Buffer.byteLength(fixture.source); }, get sha256() { return fixture.sha; } },
  { id: 'echarts', name: 'ECharts', version: 'fixture', bundled: false, url: 'https://cdn.jsdelivr.net/npm/echarts@fixture/dist/echarts.min.js', bytes: 3, sha256: 'invalid' },
  { id: 'd3', name: 'd3', version: 'fixture', bundled: true, url: 'https://cdn.jsdelivr.net/npm/d3@fixture/dist/d3.min.js', bytes: 0, sha256: '' },
] }));
const { prepareVisualizationLibraries } = await import('@/lib/visualizations/libraries');
const chart = '<script src="https://cdn.jsdelivr.net/npm/chart.js@fixture/dist/chart.umd.min.js"></script>';
const echarts = '<script src="https://cdn.jsdelivr.net/npm/echarts@fixture/dist/echarts.min.js"></script>';
beforeAll(async () => { fixture.directory = await mkdtemp(join(tmpdir(), 'o8-viz-library-')); fixture.sha = createHash('sha256').update(fixture.source).digest('hex'); });
afterAll(async () => { await rm(fixture.directory, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('pinned visualization library preparation', () => {
  it('downloads a fixed build once for concurrent callers, deduplicates tags, and stores verified bytes privately', async () => {
    const fetch = vi.fn(async () => new Response(fixture.source)); vi.stubGlobal('fetch', fetch);
    const [html, concurrent] = await Promise.all([prepareVisualizationLibraries(chart.repeat(10)), prepareVisualizationLibraries(chart)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject(['https://cdn.jsdelivr.net/npm/chart.js@fixture/dist/chart.umd.min.js', { redirect: 'error', credentials: 'omit' }]);
    expect(html.split(fixture.source)).toHaveLength(2);
    expect(concurrent).toContain(fixture.source);
    const file = join(fixture.directory, 'cache', 'visualization-libraries', `chartjs-fixture-${fixture.sha}.js`);
    expect(await readFile(file, 'utf8')).toBe(fixture.source);
    await writeFile(file, 'tampered');
    // A verified in-memory copy remains immutable even if the disk entry changes.
    expect(await prepareVisualizationLibraries(chart)).toContain(fixture.source);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects excessive script blocks and unapproved URLs before touching the network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(prepareVisualizationLibraries(chart.repeat(65))).rejects.toMatchObject({ code: 'too_many_scripts' });
    await expect(prepareVisualizationLibraries('<script src="https://example.com/d3.js"></script>')).rejects.toMatchObject({ code: 'unsupported_library' });
    await expect(prepareVisualizationLibraries(chart.replace('@fixture/', '@fixture/?copy='))).rejects.toMatchObject({ code: 'unsupported_library' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid hash and permits a retry without caching the rejected bytes', async () => {
    const fetch = vi.fn(async () => new Response('bad')); vi.stubGlobal('fetch', fetch);
    await expect(prepareVisualizationLibraries(echarts)).rejects.toMatchObject({ code: 'library_unavailable' });
    await expect(prepareVisualizationLibraries(echarts)).rejects.toMatchObject({ code: 'library_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caps a streamed body before storing it and avoids a second copy of bundled d3', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } });
    const fetch = vi.fn(async () => new Response(stream)); vi.stubGlobal('fetch', fetch);
    await expect(prepareVisualizationLibraries(echarts)).rejects.toMatchObject({ code: 'library_unavailable' });
    expect(await prepareVisualizationLibraries('<script src="https://cdn.jsdelivr.net/npm/d3@fixture/dist/d3.min.js"></script>')).toContain('data-o8-library="d3"');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
