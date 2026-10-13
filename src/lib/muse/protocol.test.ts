import { describe, expect, it } from 'vitest';
import { createMuseEventMapper, museApprovalChoice, museTerminalEvent } from './protocol';

describe('Muse protocol normalization', () => {
  it('streams each assistant item once and excludes another session', () => {
    const map = createMuseEventMapper('root');
    expect(map({ method: 'item/started', params: { sessionId: 'root', item: { itemId: 'a', kind: 'agentMessage', status: 'inProgress', text: '' } } })).toEqual([]);
    expect(map({ method: 'item/delta', params: { sessionId: 'child', itemId: 'a', delta: 'child output' } })).toEqual([]);
    expect(map({ method: 'item/delta', params: { sessionId: 'root', itemId: 'a', delta: 'Hello' } })).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(map({ method: 'item/completed', params: { sessionId: 'root', item: { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Hello' } } })).toEqual([]);
  });

  it('retains tool identities and reports completed child failures as errors', () => {
    const map = createMuseEventMapper('root');
    expect(map({ method: 'item/started', params: { sessionId: 'root', item: { itemId: 'tool', kind: 'toolCall', tool: 'read_file', args: '{"path":"README.md"}', status: 'inProgress' } } })).toEqual([{ type: 'tool_use', id: 'tool', name: 'read_file', input: { path: 'README.md' } }]);
    expect(map({ method: 'item/completed', params: { sessionId: 'root', item: { itemId: 'child-item', kind: 'subagent', subagentId: 'child', status: 'completed', failureKind: 'modelError', finalSummary: 'No answer' } } })).toEqual([expect.objectContaining({ type: 'tool_result', id: 'child-item', name: 'subagent:child', isError: true })]);
  });

  it('does not infer success from a failed or unknown terminal', () => {
    expect(museTerminalEvent({ terminal: 'completed', sessionId: 'root' })).toEqual({ type: 'done', sessionId: 'root', cost: null });
    expect(museTerminalEvent({ terminal: 'failed', sessionId: 'root', error: { kind: 'authRequired', message: 'secret diagnostic' } })).toMatchObject({ type: 'error', code: 'authRequired' });
    expect(museTerminalEvent({ terminal: 'new-terminal', sessionId: 'root' })).toMatchObject({ type: 'error' });
  });

  it('selects only a server-offered one-time approval and defaults to denial', () => {
    const request = { availableChoices: [
      { choiceId: 'persist', decision: 'approvedForSession', scope: 'session' },
      { choiceId: 'once', decision: 'approved', scope: 'once' },
      { choiceId: 'deny', decision: 'denied', scope: 'once' },
    ] };
    expect(museApprovalChoice(request, true)).toBe('once');
    expect(museApprovalChoice(request, false)).toBe('deny');
    expect(museApprovalChoice({ availableChoices: [request.availableChoices[0]] }, true)).toBeNull();
  });
});
