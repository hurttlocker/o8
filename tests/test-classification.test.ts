import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyTestSource } from '../scripts/lib/test-classification.mjs';

const classificationScript = fileURLToPath(new URL('../scripts/classify-tests.mjs', import.meta.url));

function runClassification(root: string, mode: '--check' | '--write') {
  return spawnSync(process.execPath, [classificationScript, mode], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('test factory classification', () => {
  it('routes real Git, process, APFS, and listener ownership to integration', () => {
    expect(classifyTestSource('tests/lane-real-path.test.ts', 'describe("plain", () => {})'))
      .toContain('real-path');
    expect(classifyTestSource('tests/plain.test.ts', "import { spawn } from 'node:child_process'"))
      .toContain('child-process');
    expect(classifyTestSource('tests/plain.test.ts', "execFileSync('git', ['init'])"))
      .toEqual(expect.arrayContaining(['child-process', 'git-cli']));
    expect(classifyTestSource('tests/plain.test.ts', 'const server = createServer(handler)'))
      .toContain('network-listener');
  });

  it('leaves a pure in-memory assertion in the hermetic unit lane', () => {
    expect(classifyTestSource('src/lib/math.test.ts', 'expect(1 + 1).toBe(2)')).toEqual([]);
  });

  it('writes list-only manifests and rejects missing or stale resource-owning paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-test-classification-'));
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/hermetic.test.ts'), 'expect(1 + 1).toBe(2);\n');
    writeFileSync(
      join(root, 'tests/resource.test.ts'),
      ['const server = create', 'Server(handler);\n'].join(''),
    );

    try {
      const writeResult = runClassification(root, '--write');
      expect(writeResult.status).toBe(0);
      expect(writeResult.stdout).toContain('[test-classification] 1 hermetic, 1 resource-owning');

      const manifestPath = join(root, 'tests/test-classification.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest).not.toHaveProperty('totalTests');
      expect(manifest).not.toHaveProperty('hermeticTests');
      expect(manifest).not.toHaveProperty('resourceOwningTests');
      expect(manifest.resourceOwning).toEqual([{
        path: 'tests/resource.test.ts',
        reasons: ['network-listener'],
      }]);

      const matchingResult = runClassification(root, '--check');
      expect(matchingResult.status).toBe(0);
      expect(matchingResult.stdout).toContain('manifest matches resource-owning source markers');

      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, resourceOwning: [] }, null, 2)}\n`);
      const missingResult = runClassification(root, '--check');
      expect(missingResult.status).toBe(1);
      expect(missingResult.stderr).toContain('manifest drifted');

      writeFileSync(manifestPath, `${JSON.stringify({
        ...manifest,
        resourceOwning: [
          ...manifest.resourceOwning,
          { path: 'tests/stale.test.ts', reasons: ['network-listener'] },
        ],
      }, null, 2)}\n`);
      const staleResult = runClassification(root, '--check');
      expect(staleResult.status).toBe(1);
      expect(staleResult.stderr).toContain('manifest drifted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
