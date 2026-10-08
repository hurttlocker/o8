import { describe, expect, it } from 'vitest';
import type { ProjectContext } from '@/lib/projects/context';
import type { ProjectRecord } from '@/lib/repos/projects';
import { taskPanelProjectId } from './panel-project-identity';

const context = { id: 'sqlite', panelProjectId: 'default', name: 'Workspace', slug: 'workspace' } as ProjectContext;
const panel = { id: 'default', name: 'Workspace', repoPaths: ['/repo'] } as ProjectRecord;
describe('authoritative task panel identity', () => {
  it('maps the unique canonical pair while retaining the persisted runtime identity', () => {
    expect(taskPanelProjectId(context, [panel])).toBe('default');
    expect(context.id).toBe('sqlite');
  });
  it('prefers a unique exact identity over unrelated projects sharing a display name', () => {
    expect(taskPanelProjectId({ ...context, id: 'default' }, [panel, { ...panel, id: 'another' }])).toBe('default');
    expect(taskPanelProjectId({ ...context, id: 'default' }, [panel, panel])).toBeNull();
    expect(taskPanelProjectId({ ...context, id: 'repo:one', panelProjectId: 'repo:one' }, [{ ...panel, id: 'repo:one' }, panel])).toBe('repo:one');
  });
  it('refuses ambiguous identities and overlapping repos with different identities', () => {
    expect(taskPanelProjectId(context, [panel, { ...panel, id: 'another' }])).toBeNull();
    expect(taskPanelProjectId(context, [{ ...panel, name: 'Different project' }])).toBeNull();
    expect(taskPanelProjectId({ ...context, panelProjectId: 'unrelated' }, [panel])).toBeNull();
    expect(taskPanelProjectId({ ...context, panelProjectId: ' default ' }, [panel])).toBeNull();
  });
});
