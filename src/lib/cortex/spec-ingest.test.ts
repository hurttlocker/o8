import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { specIngestSlugFromId, purgeOrphanedSpecDirectives } from './spec-ingest';

describe('specIngestSlugFromId', () => {
  it('extracts the slug from a spec-ingest id', () => {
    expect(specIngestSlugFromId('spec-ingest:cortex-ide:claude-md:overview')).toBe('cortex-ide');
  });
  it('extracts the slug from an H3-extended id', () => {
    expect(specIngestSlugFromId('spec-ingest:o8:design-md:06-motifs:flat-icon')).toBe('o8');
  });
  it('lower-cases the slug (matches the basename comparison)', () => {
    expect(specIngestSlugFromId('spec-ingest:O8:x:y')).toBe('o8');
  });
  it('returns null for a hand-authored seed id', () => {
    expect(specIngestSlugFromId('seed-orchestrator-default')).toBeNull();
  });
  it('returns null for any non-spec-ingest id', () => {
    expect(specIngestSlugFromId('some-other:thing')).toBeNull();
  });
});

function directiveMd(id: string): string {
  return `---\nid: ${id}\ntitle: "t"\nscope: repo\nrepoName: "x"\n---\n\n# t\n\nbody body body body\n`;
}

describe('purgeOrphanedSpecDirectives (#1228 auto-heal repo rename)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'o8-purge-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (file: string, id: string) => writeFileSync(join(dir, file), directiveMd(id), 'utf-8');

  it('purges spec-ingest rows whose slug matches no live repo, keeps the live ones', () => {
    write('a.md', 'spec-ingest:cortex-ide:claude-md:overview'); // orphaned (old slug)
    write('b.md', 'spec-ingest:cortex-ide:agents-md:overview');  // orphaned (old slug)
    write('c.md', 'spec-ingest:o8:claude-md:overview');          // live
    const res = purgeOrphanedSpecDirectives(new Set(['o8']), { directivesDir: dir, sqlite: null });
    expect(res.purged).toBe(2);
    expect(res.slugs).toEqual(['cortex-ide']);
    expect(readdirSync(dir)).toEqual(['c.md']);
  });

  it('never touches hand-authored seed-* directives (even when they name the old slug)', () => {
    write('seed.md', 'seed-cortex-ide-rule');           // not a spec-ingest id
    write('orphan.md', 'spec-ingest:cortex-ide:x:y');   // orphaned spec-ingest
    const res = purgeOrphanedSpecDirectives(new Set(['o8']), { directivesDir: dir, sqlite: null });
    expect(res.purged).toBe(1);
    expect(readdirSync(dir)).toEqual(['seed.md']);
  });

  it('SAFETY: an empty live-slug set purges NOTHING (a failed repo lookup must not wipe the brain)', () => {
    write('a.md', 'spec-ingest:cortex-ide:x:y');
    write('b.md', 'spec-ingest:o8:x:y');
    const res = purgeOrphanedSpecDirectives(new Set(), { directivesDir: dir, sqlite: null });
    expect(res.purged).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });

  it('matches live slugs case-insensitively (caller may pass mixed case)', () => {
    write('a.md', 'spec-ingest:o8:x:y'); // id slug lower-cases to o8
    const res = purgeOrphanedSpecDirectives(new Set(['O8']), { directivesDir: dir, sqlite: null });
    expect(res.purged).toBe(0);
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('keeps a repo whose name differs from its basename (both are live slugs)', () => {
    // A repo at /x/myrepo registered as "cool-project" stamps repoName: cool-project.
    // The caller adds BOTH slugs to liveSlugs, so neither is treated as orphaned.
    write('a.md', 'spec-ingest:cool-project:x:y');
    write('b.md', 'spec-ingest:myrepo:x:y');
    const res = purgeOrphanedSpecDirectives(new Set(['cool-project', 'myrepo']), { directivesDir: dir, sqlite: null });
    expect(res.purged).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });
});
