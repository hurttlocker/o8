import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  home: '',
  requirePanelAuth: vi.fn(),
  findRepoByLocalPath: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: { homedir: () => h.home },
  homedir: () => h.home,
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.requirePanelAuth }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: h.findRepoByLocalPath }));

import { GET } from './route';

function writeSkill(root: string, folder: string, name: string, description: string, body = 'Private instructions') {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

function request(repo?: string) {
  const url = new URL('http://localhost/api/customize/inventory');
  if (repo) url.searchParams.set('repo', repo);
  return new NextRequest(url);
}

describe('GET /api/customize/inventory skills', () => {
  let fixtureRoot: string;
  let repo: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync('/tmp/o8-customize-inventory-');
    h.home = path.join(fixtureRoot, 'home');
    repo = path.join(fixtureRoot, 'repo');
    mkdirSync(h.home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    h.requirePanelAuth.mockReset().mockReturnValue(null);
    h.findRepoByLocalPath.mockReset().mockImplementation(async (candidate: string) => (
      candidate === repo ? { localPath: repo } : null
    ));
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('returns bounded metadata from every supported root and keeps duplicate source identities', async () => {
    writeSkill(path.join(h.home, '.o8', 'skills'), 'o8-one', 'o8-one', 'o8 skill');
    writeSkill(path.join(h.home, '.agents', 'skills'), 'shared-one', 'shared-one', 'shared skill');
    writeSkill(path.join(h.home, '.codex', 'skills'), 'duplicate', 'duplicate', 'Codex copy', 'CODEX PRIVATE BODY');
    writeSkill(path.join(h.home, '.claude', 'skills'), 'duplicate', 'duplicate', 'Claude copy', 'CLAUDE PRIVATE BODY');
    writeSkill(path.join(h.home, '.gemini', 'skills'), 'gemini-one', 'gemini-one', 'Gemini skill');
    writeSkill(path.join(repo, '.agents', 'skills'), 'project-shared', 'project-shared', 'Project shared skill');
    writeSkill(path.join(repo, '.claude', 'skills'), 'project-claude', 'project-claude', 'Project Claude skill');

    const response = await GET(request(repo));
    const payload = await response.json() as { skills: Array<{ name: string; source: string; scope: string }> };

    expect(response.status).toBe(200);
    expect(payload.skills).toHaveLength(7);
    expect(payload.skills.filter((skill) => skill.name === 'duplicate')).toEqual([
      expect.objectContaining({ source: 'claude-code', scope: 'user' }),
      expect.objectContaining({ source: 'codex', scope: 'user' }),
    ]);
    expect(new Set(payload.skills.map((skill) => skill.source))).toEqual(new Set([
      'o8', 'shared', 'codex', 'claude-code', 'gemini',
    ]));
    expect(JSON.stringify(payload)).not.toContain('PRIVATE BODY');
  });

  it('skips oversized files and skill symlinks that escape their intended root', async () => {
    const codexRoot = path.join(h.home, '.codex', 'skills');
    writeSkill(codexRoot, 'valid', 'valid', 'Safe metadata');
    writeSkill(codexRoot, 'oversized', 'oversized', 'Too large', 'x'.repeat(70 * 1024));
    const outside = path.join(fixtureRoot, 'outside');
    writeSkill(outside, 'escaped', 'escaped', 'Outside root');
    mkdirSync(path.join(codexRoot, 'linked'), { recursive: true });
    symlinkSync(path.join(outside, 'escaped', 'SKILL.md'), path.join(codexRoot, 'linked', 'SKILL.md'));

    const response = await GET(request());
    const payload = await response.json() as { skills: Array<{ name: string }> };

    expect(payload.skills.map((skill) => skill.name)).toEqual(['valid']);
  });

  it('rejects a skill root linked outside the registered repository and deduplicates identical files', async () => {
    const outside = path.join(fixtureRoot, 'outside');
    writeSkill(outside, 'escaped', 'escaped', 'Outside repository');
    mkdirSync(path.join(repo, '.agents'), { recursive: true });
    symlinkSync(outside, path.join(repo, '.agents', 'skills'));
    const root = path.join(h.home, '.codex', 'skills');
    writeSkill(root, 'original', 'original', 'One file');
    symlinkSync(path.join(root, 'original'), path.join(root, 'alias'));

    const response = await GET(request(repo));
    const payload = await response.json() as { skills: Array<{ name: string }> };
    expect(payload.skills.map((skill) => skill.name)).toEqual(['original']);
  });

  it('rejects agent and hook files linked outside the registered repository', async () => {
    const outside = path.join(fixtureRoot, 'outside-metadata');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'agent.md'), '---\nname: escaped-agent\ndescription: Must not leak\n---\n');
    writeFileSync(path.join(outside, 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'outside-command' }] }] },
    }));

    const agentsRoot = path.join(repo, '.claude', 'agents');
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(path.join(agentsRoot, 'safe.md'), '---\nname: safe-agent\ndescription: Inside repository\n---\n');
    symlinkSync(path.join(outside, 'agent.md'), path.join(agentsRoot, 'escaped.md'));
    symlinkSync(path.join(outside, 'settings.json'), path.join(repo, '.claude', 'settings.json'));

    const response = await GET(request(repo));
    const payload = await response.json() as {
      agents: Array<{ name: string }>;
      hooks: Array<{ command: string }>;
    };

    expect(payload.agents.map((agent) => agent.name)).toEqual(['safe-agent']);
    expect(payload.hooks).toEqual([]);
  });

  it('reads CRLF frontmatter and common block descriptions as bounded text', async () => {
    const skillDir = path.join(h.home, '.codex', 'skills', 'block-description');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: block-description',
      'description: |',
      '  First line.',
      '  Second line.',
      '---',
      'Private body',
    ].join('\r\n'));

    const response = await GET(request());
    const payload = await response.json() as { skills: Array<{ name: string; description: string }> };

    expect(payload.skills).toEqual([
      expect.objectContaining({ name: 'block-description', description: 'First line. Second line.' }),
    ]);
  });

  it('requires panel authorization before reading inventory', async () => {
    h.requirePanelAuth.mockReturnValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const response = await GET(request(repo));

    expect(response.status).toBe(401);
    expect(h.findRepoByLocalPath).not.toHaveBeenCalled();
  });

  it('rejects traversal and unregistered repository paths', async () => {
    const invalid = await GET(request('/tmp/repo/../private'));
    expect(invalid.status).toBe(400);
    expect(h.findRepoByLocalPath).not.toHaveBeenCalled();

    const unregistered = path.join(fixtureRoot, 'unregistered');
    mkdirSync(unregistered);
    writeSkill(path.join(unregistered, '.agents', 'skills'), 'private', 'private', 'Must not leak');
    const denied = await GET(request(unregistered));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'repo_not_registered' } });
  });
});
