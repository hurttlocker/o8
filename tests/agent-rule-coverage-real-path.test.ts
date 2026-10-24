import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-rule-coverage-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  cpSync('AGENTS.md', join(root, 'AGENTS.md'));
  cpSync('scripts/agent-rule-coverage.json', join(root, 'scripts/agent-rule-coverage.json'));
  for (const name of ['o8-code', 'o8-ui', 'o8-checks', 'o8-contribute', 'o8-delegate', 'o8-release']) {
    const directory = join(root, '.agents/skills', name);
    mkdirSync(directory, { recursive: true });
    cpSync(`.agents/skills/${name}/SKILL.md`, join(directory, 'SKILL.md'));
  }
  return root;
}

function run(root: string) {
  const result = spawnSync(process.execPath, ['scripts/check-agent-rules.mjs', '--root', root], { encoding: 'utf8' });
  return { status: result.status, ...JSON.parse(result.stdout) };
}

afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('agent rule coverage CLI', () => {
  it('checks the actual core, six skills and all 30 original rule units', () => {
    const output = JSON.parse(execFileSync(process.execPath, ['scripts/check-agent-rules.mjs'], { encoding: 'utf8' }));
    expect(output).toMatchObject({ ok: true, rules: 30, skills: 6, errors: [] });
    expect(output.bytes).toBeLessThan(2000);
  });

  it('fails when an original safety rule disappears from the core', () => {
    const root = fixture();
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Read-only or diagnostic work stays non-mutating.', 'Diagnostics may write.'));
    expect(run(root)).toMatchObject({ status: 1, ok: false, errors: expect.arrayContaining([expect.stringContaining('R03: missing or changed')]) });
  });

  it('fails when a moved verification rule changes', () => {
    const root = fixture();
    const file = join(root, '.agents/skills/o8-checks/SKILL.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Helper-only tests are not', 'Helper-only tests are'));
    expect(run(root)).toMatchObject({ status: 1, ok: false, errors: expect.arrayContaining([expect.stringContaining('R20: missing or changed')]) });
  });

  it('refuses a rewritten privacy rule even when its destination hash is refreshed', () => {
    const root = fixture();
    const file = join(root, '.agents/skills/o8-contribute/SKILL.md');
    const text = readFileSync(file, 'utf8').replace('billing notes, or internal routing notes', 'internal notes');
    writeFileSync(file, text);
    const unit = text.split('\n\n').find((paragraph) => paragraph.startsWith('- For issues'))!
      .replace('[the GitHub standard](../../../docs/operations/github-operating-standard.md)', '<github-standard>')
      .replace(/\s+/g, ' ').trim();
    const manifestPath = join(root, 'scripts/agent-rule-coverage.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.rules.find((rule: { id: string }) => rule.id === 'R22').sha256 = createHash('sha256').update(unit).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(run(root)).toMatchObject({ status: 1, ok: false,
      errors: expect.arrayContaining(['R22: rule changed beyond portable reference normalization.']) });
  });

  it('limits the portable locator to the published repository contract', () => {
    const root = fixture();
    const file = join(root, '.agents/skills/o8-contribute/SKILL.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('docs/operations/github-operating-standard.md', 'docs/README.md'));
    expect(run(root)).toMatchObject({ status: 1, ok: false,
      errors: expect.arrayContaining(['R22: incorrect portable GitHub standard locator.']) });
  });

  it('fails when the core exceeds its byte budget', () => {
    const root = fixture();
    const file = join(root, 'AGENTS.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${'x'.repeat(2000)}`);
    expect(run(root)).toMatchObject({ status: 1, ok: false, errors: expect.arrayContaining([expect.stringContaining('under 2000')]) });
  });

  it.each(['route', 'trigger'])('fails when a skill loses its %s', (kind) => {
    const root = fixture();
    const file = kind === 'route' ? join(root, 'AGENTS.md') : join(root, '.agents/skills/o8-ui/SKILL.md');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, kind === 'route'
      ? text.replace('.agents/skills/o8-ui/SKILL.md', 'missing-skill.md')
      : text.replace(/^description: .+\n/m, ''));
    const output = run(root);
    expect(output.status).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.errors.join(' ')).toContain(kind === 'route' ? 'missing core route' : 'trigger description');
  });
});
