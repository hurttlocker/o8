import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sourceTemplate = fileURLToPath(new URL('./orchestrator.md', import.meta.url));
const originalCwd = process.cwd();
const originalPackagedApp = process.env.O8_PACKAGED_APP;
const tempRoots: string[] = [];

async function buildFromUnavailableSource(packagedRoot: string): Promise<string> {
  const unavailableSource = join(packagedRoot, 'missing-build-checkout', 'orchestrator-system-prompt.ts');
  const realNodeUrl = await vi.importActual<typeof import('node:url')>('node:url');

  vi.resetModules();
  vi.doMock('node:url', () => ({
    ...realNodeUrl,
    fileURLToPath: (url: Parameters<typeof fileURLToPath>[0]) => (
      String(url).includes('orchestrator-system-prompt')
        ? unavailableSource
        : realNodeUrl.fileURLToPath(url)
    ),
  }));
  process.chdir(packagedRoot);
  process.env.O8_PACKAGED_APP = '1';

  const { buildOrchestratorSystemPrompt } = await import('./orchestrator-system-prompt');
  return buildOrchestratorSystemPrompt('/tmp/example-repo', {
    backend: 'claude',
    firstRunClarify: false,
  });
}

afterEach(() => {
  vi.doUnmock('node:url');
  vi.resetModules();
  process.chdir(originalCwd);
  if (originalPackagedApp === undefined) delete process.env.O8_PACKAGED_APP;
  else process.env.O8_PACKAGED_APP = originalPackagedApp;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildOrchestratorSystemPrompt packaged template loading', () => {
  it('loads the packaged server template when the build checkout is unavailable', async () => {
    const packagedRoot = mkdtempSync(join(tmpdir(), 'o8-packaged-prompt-'));
    tempRoots.push(packagedRoot);
    const packagedTemplate = join(packagedRoot, 'orchestrator.md');
    mkdirSync(dirname(packagedTemplate), { recursive: true });
    cpSync(sourceTemplate, packagedTemplate);

    const prompt = await buildFromUnavailableSource(packagedRoot);

    expect(prompt).toContain('## ORCHESTRATOR PROTOCOL');
    expect(prompt).toContain('Clarify-first — interview before dispatch');
    expect(prompt).not.toContain('The markdown prompt file could not be loaded.');
  });

  it('keeps the minimal fallback when no packaged or source template exists', async () => {
    const packagedRoot = mkdtempSync(join(tmpdir(), 'o8-missing-packaged-prompt-'));
    tempRoots.push(packagedRoot);

    const prompt = await buildFromUnavailableSource(packagedRoot);

    expect(prompt).toContain('The markdown prompt file could not be loaded.');
    expect(prompt).not.toContain('## ORCHESTRATOR PROTOCOL');
  });
});
