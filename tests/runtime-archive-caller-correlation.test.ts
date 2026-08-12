import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

function sourceSection(file: string, start: string, end: string): string {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `${start} missing from ${file}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${end} missing after ${start} in ${file}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('desktop runtime archive callers', () => {
  it.each([
    {
      file: 'src/components/desktop/AgentPanelExtraAgents.tsx',
      start: 'const handleArchive = useCallback',
      end: 'const toggleCollapsed = useCallback',
      rollbackSet: 'setArchivedRowKeys',
    },
    {
      file: 'src/components/desktop/repo-registry/RepoBranchRow.tsx',
      start: 'const handleDismissAgent = useCallback',
      end: 'const scheduleAgentHover = useCallback',
      rollbackSet: 'setDismissedSessionKeys',
    },
  ])('$file keeps one correlation id and rolls back an unconfirmed optimistic hide', ({
    file,
    start,
    end,
    rollbackSet,
  }) => {
    const section = sourceSection(file, start, end);
    expect(section).toContain('const clientMutationId = crypto.randomUUID()');
    expect(section).toContain('await archiveRuntimeTarget(');
    expect(section).toContain('clientMutationId');
    expect(section).toContain('catch');
    expect(section.match(new RegExp(rollbackSet, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(section).toContain('.delete(');
  });
});
