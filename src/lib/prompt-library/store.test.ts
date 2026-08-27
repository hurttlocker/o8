import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-prompt-library-'));

const { getSqlite } = await import('@/lib/db');
const {
  PromptLibraryDuplicateError,
  createPromptLibraryEntry,
  deletePromptLibraryEntry,
  getPromptLibraryEntry,
  importPromptLibrarySources,
  listPromptLibraryEntries,
  listPromptLibraryImportSources,
  recordPromptLibraryUse,
  updatePromptLibraryEntry,
} = await import('./store');

describe('prompt library store', () => {
  beforeEach(() => {
    getSqlite().exec('DELETE FROM prompt_library');
  });

  it('stores only intentional entries and suppresses scoped body duplicates', () => {
    const first = createPromptLibraryEntry({
      title: 'Security review',
      body: 'Inspect authentication boundaries.  \r\nReport concrete findings.',
      tags: ['Security', 'review', 'security'],
      scope: 'global',
    });
    const duplicate = createPromptLibraryEntry({
      title: 'Same instructions',
      body: 'Inspect authentication boundaries.\nReport concrete findings.',
      scope: 'global',
    });

    expect(first.created).toBe(true);
    expect(first.entry.tags).toEqual(['Security', 'review']);
    expect(duplicate).toEqual({ entry: first.entry, created: false });
    expect(listPromptLibraryEntries({ scope: 'all' })).toHaveLength(1);
  });

  it('keeps global and per-repo prompts separate while listing current availability', () => {
    const global = createPromptLibraryEntry({ title: 'Global audit', body: 'Audit dependencies.' }).entry;
    const repoOne = createPromptLibraryEntry({
      title: 'Repo one release',
      body: 'Run repo one release checks.',
      tags: ['release'],
      scope: 'repo',
      repoPath: '/repos/one',
    }).entry;
    createPromptLibraryEntry({
      title: 'Repo two release',
      body: 'Run repo two release checks.',
      scope: 'repo',
      repoPath: '/repos/two',
    });

    expect(listPromptLibraryEntries({ repoPath: '/repos/one' }).map((entry) => entry.id).sort())
      .toEqual([global.id, repoOne.id].sort());
    expect(listPromptLibraryEntries({ query: 'release', scope: 'repo', repoPath: '/repos/one' }))
      .toEqual([repoOne]);
  });

  it('tracks use for recent ordering and keeps terminal data readable', () => {
    const older = createPromptLibraryEntry({ title: 'Older', body: 'First reusable prompt.' }).entry;
    const newer = createPromptLibraryEntry({ title: 'Newer', body: 'Second reusable prompt.' }).entry;

    expect(listPromptLibraryEntries({ scope: 'all' })[0]?.id).toBe(newer.id);
    const used = recordPromptLibraryUse(older.id, Date.now() + 1_000);
    expect(used).toMatchObject({ id: older.id, useCount: 1 });
    expect(listPromptLibraryEntries({ scope: 'all' })[0]?.id).toBe(older.id);
    expect(getPromptLibraryEntry(older.id)?.body).toBe('First reusable prompt.');
  });

  it('rejects an edit that would create a duplicate and deletes explicitly', () => {
    const first = createPromptLibraryEntry({ title: 'First', body: 'First body.' }).entry;
    const second = createPromptLibraryEntry({ title: 'Second', body: 'Second body.' }).entry;

    expect(() => updatePromptLibraryEntry(second.id, { body: first.body }))
      .toThrow(PromptLibraryDuplicateError);
    expect(deletePromptLibraryEntry(first.id)).toBe(true);
    expect(deletePromptLibraryEntry(first.id)).toBe(false);
    expect(getPromptLibraryEntry(first.id)).toBeNull();
  });

  it('offers existing automation and watched-agent briefs, then imports them idempotently', () => {
    const sqlite = getSqlite();
    sqlite.prepare(`
      INSERT INTO automations (id, name, owner, repo_path, runtime, prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('auto-import-1', 'Release review', 'operator', '/repos/o8', 'codex', 'Run release checks.');
    sqlite.prepare(`
      INSERT INTO watched_agents (surface_id, repo_path, name, prompt, registered_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('watched-import-1', '/repos/o8', 'Security worker', 'Review authentication boundaries.', 1, 1);
    sqlite.prepare(`
      INSERT INTO automations (id, name, owner, repo_path, runtime, prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('auto-other-repo', 'Other repo', 'operator', '/repos/other', 'codex', 'Run other checks.');

    const sources = listPromptLibraryImportSources({ repoPath: '/repos/o8' });
    expect(sources).toEqual([
      expect.objectContaining({ sourceKind: 'automation', sourceId: 'auto-import-1', title: 'Release review' }),
      expect.objectContaining({ sourceKind: 'watched_agent', sourceId: 'watched-import-1', title: 'Security worker' }),
    ]);

    const imported = importPromptLibrarySources({ sources, repoPath: '/repos/o8' });
    expect(imported).toMatchObject({ created: 2, skipped: 0 });
    expect(listPromptLibraryEntries({ repoPath: '/repos/o8' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: 'automation', sourceId: 'auto-import-1', tags: ['automation'] }),
      expect.objectContaining({ sourceKind: 'watched_agent', sourceId: 'watched-import-1', tags: ['watched agent'] }),
    ]));
    expect(listPromptLibraryImportSources({ repoPath: '/repos/o8' })).toEqual([]);
    expect(importPromptLibrarySources({ sources, repoPath: '/repos/o8' }))
      .toMatchObject({ created: 0, skipped: 2 });
  });
});
