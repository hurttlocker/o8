import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOpenCodeServiceFixture } from '../../../tests/helpers/opencode-service-fixture';
import { releaseOpenCodeWorkspace } from './service-lifecycle';

const roots: string[] = [];

afterEach(() => {
  delete process.env.O8_OPENCODE_BIN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode service workspace lifecycle', () => {
  it('refuses to evict a workspace with an active session', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'o8-opencode-lifecycle-'));
    roots.push(root);
    const worktreePath = join(root, 'worktree');
    mkdirSync(worktreePath);
    const fixture = createOpenCodeServiceFixture(root, worktreePath, {
      activeSessionId: 'ses_active',
    });
    process.env.O8_OPENCODE_BIN = fixture.opencodeBin;

    await expect(releaseOpenCodeWorkspace(worktreePath)).resolves.toEqual({
      released: false,
      reason: 'location-active',
      activeSessionIds: ['ses_active'],
      note: 'OpenCode still reports 1 active session in this workspace.',
    });
    expect(fixture.readLog().some((call) => call.startsWith('opencode api delete'))).toBe(false);
  });
});
