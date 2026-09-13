import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const thoughtsRoot = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

describe('composer selector storage ownership', () => {
  it('keeps direct localStorage access inside state.ts', () => {
    const files = ['ComposerSelectorFooter.tsx', 'useComposerSelectorState.ts', 'ComposerPicker.tsx'];
    for (const file of files) {
      const source = readFileSync(`${here}/${file}`, 'utf8');
      expect(source, file).not.toMatch(/localStorage\.(getItem|setItem|removeItem|clear)\s*\(/);
    }
    const state = readFileSync(`${here}/state.ts`, 'utf8');
    expect(state).toMatch(/localStorage\.getItem/);
    expect(state).toMatch(/localStorage\.setItem/);
  });

  it('keeps selector persistence and operator-default requests behind the shared seams', () => {
    const forbiddenStorage = /localStorage\.(?:getItem|setItem)\(\s*['"]o8:orchestrator:(?:model-|thinking-preference|swarm-|orchestration-mode)/;
    for (const file of sourceFiles(thoughtsRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(forbiddenStorage);
      expect(source, file).not.toContain('/api/panel/operator-defaults');
    }
    const hook = readFileSync(`${here}/useComposerSelectorState.ts`, 'utf8');
    expect(hook).toContain('readStoredOrchestratorModel');
    expect(hook).toContain('writeComposerModelEffort');
    expect(hook).toContain('fetchOperatorDefaultsValues');
    expect(hook).toContain('updateOperatorDefaultsValues');
  });
});
