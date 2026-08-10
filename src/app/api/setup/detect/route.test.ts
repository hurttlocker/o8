import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => {
      throw new Error('missing cli');
    },
  };
});

vi.mock('@/lib/runtimes/shared/cli-locate', () => ({
  scanAndLink: () => null,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('GET /api/setup/detect', () => {
  it('reports optional CLI runtimes as gracefully absent when their CLIs are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('GROK_CODE_XAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');

    const { GET } = await import('./route');
    const response = await GET();
    const data = await response.json() as {
      tools: Array<{ id: string; name: string; detected: boolean; ready?: boolean; authHint?: string }>;
      codexVoiceCapability?: {
        capable: boolean;
        installation: { installed: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(data.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '3code', name: '3code CLI', detected: false }),
      expect.objectContaining({ id: 'magnitude', name: 'Magnitude CLI', detected: false }),
      expect.objectContaining({ id: 'cursor', name: 'Cursor CLI', detected: false }),
      expect.objectContaining({ id: 'grok', name: 'Grok Build', detected: false }),
      expect.objectContaining({ id: 'pi', name: 'Pi', detected: false }),
    ]));
    for (const id of ['3code', 'magnitude', 'cursor', 'grok', 'pi']) {
      const tool = data.tools.find((entry) => entry.id === id);
      expect(tool?.ready).toBeUndefined();
      expect(tool?.authHint).toBeUndefined();
    }
    expect(data.codexVoiceCapability).toMatchObject({
      capable: false,
      installation: { installed: false },
    });
  });
});
