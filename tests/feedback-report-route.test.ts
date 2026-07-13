/**
 * Real-path test for the bug-report intake (reachability rule).
 *
 * The digest logic is unit-tested in crash-digest.test.ts. This drives the ACTUAL
 * route handler with a constructed Request and asserts the crashes reach Discord —
 * the seam that matters, and the one a helper-only test would leave unreached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrashRecord } from '@/lib/telemetry/crash-store';

const crashRecords = vi.hoisted(() => ({ current: [] as CrashRecord[] }));

vi.mock('@/lib/telemetry/crash-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry/crash-store')>()),
  readCrashRecords: () => crashRecords.current,
}));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));
vi.mock('@/lib/repos/projects', () => ({
  getActiveProjectScopeForRepoSync: () => ({ project: { name: 'Workspace' } }),
}));
vi.mock('@/lib/runtime/ide-surface-state', () => ({
  readIdeSurfaceState: () => null,
}));

import { POST } from '@/app/api/feedback/report/route';

interface DiscordEmbedField { name: string; value: string; inline?: boolean }
interface CapturedPost { form: FormData | null; json: unknown }

const captured: CapturedPost = { form: null, json: null };

function postReport(body: Record<string, unknown>) {
  return POST(
    new Request('http://127.0.0.1:3001/api/feedback/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function embedOf(form: FormData): Promise<{ fields: DiscordEmbedField[] }> {
  const payload = JSON.parse(String(form.get('payload_json'))) as { embeds: { fields: DiscordEmbedField[] }[] };
  return payload.embeds[0];
}

beforeEach(() => {
  crashRecords.current = [];
  captured.form = null;
  captured.json = null;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (init.body instanceof FormData) captured.form = init.body;
    else captured.json = JSON.parse(String(init.body));
    return new Response(null, { status: 204 });
  });
});

function crash(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    ts: Date.now() - 60_000,
    source: 'renderer',
    appVersion: '0.1.591',
    kind: 'window.error',
    message: 'TypeError: diff is undefined',
    stack: 'at DiffPanel (DiffPanel.tsx:42)',
    ...overrides,
  };
}

describe('POST /api/feedback/report', () => {
  it('attaches recent crashes as a file and a Crashes field', async () => {
    crashRecords.current = [crash()];

    const res = await postReport({ category: 'bug', message: 'diff panel went blank', route: '/dashboard' });
    expect(res.status).toBe(200);

    const form = captured.form;
    expect(form, 'crashes must force the multipart path even with no screenshot').not.toBeNull();

    const file = form!.get('files[0]') as File;
    expect(file.name).toBe('crashes.txt');
    const text = await file.text();
    expect(text).toContain('TypeError: diff is undefined');
    expect(text).toContain('at DiffPanel (DiffPanel.tsx:42)');

    const embed = await embedOf(form!);
    const field = embed.fields.find((f) => f.name === 'Crashes');
    expect(field?.value).toContain('1 in the last 24h');
    expect(field?.inline).toBe(false);
  });

  it('sends plain JSON with no Crashes field when the log is clean', async () => {
    const res = await postReport({ category: 'request', message: 'add dark mode to canvas', route: '/dashboard' });
    expect(res.status).toBe(200);

    expect(captured.form, 'a clean log must not force a multipart upload').toBeNull();
    const payload = captured.json as { embeds: { fields: DiscordEmbedField[] }[] };
    expect(payload.embeds[0].fields.some((f) => f.name === 'Crashes')).toBe(false);
  });

  it('ignores crashes older than the 24h window', async () => {
    crashRecords.current = [crash({ ts: Date.now() - 48 * 60 * 60 * 1000 })];

    await postReport({ category: 'bug', message: 'stale crash must not ride along', route: '/dashboard' });
    expect(captured.form).toBeNull();
  });

  it('does not let a screenshot named crashes.txt shadow the crash file', async () => {
    crashRecords.current = [crash()];

    await postReport({
      category: 'bug',
      message: 'collision',
      route: '/dashboard',
      images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'crashes.txt' }],
    });

    const form = captured.form!;
    const names = form.getAll('files[0]').concat(form.getAll('files[1]')).map((f) => (f as File).name);
    expect(names).toContain('crashes.txt');
    expect(names).toContain('crashes-1.txt');
  });

  it('still rejects an invalid report before touching the crash log', async () => {
    crashRecords.current = [crash()];
    const res = await postReport({ category: 'bug', message: '   ' });
    expect(res.status).toBe(400);
    expect(captured.form).toBeNull();
    expect(captured.json).toBeNull();
  });
});
