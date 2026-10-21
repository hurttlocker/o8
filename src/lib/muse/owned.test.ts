import { describe, expect, it } from 'vitest';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import { museWorkerArgs, parseMuseRunLog } from './owned';

const run = { id: 'run', mode: 'launch', prompt: 'task', startedAt: new Date(0).toISOString(), pid: 1,
  stdoutPath: 'stdout', stderrPath: 'stderr', outcome: 'finished' } satisfies OwnedRunRecord;
const frame = (type: string, payload: unknown, durability = 'durable') => JSON.stringify({ schema_version: 1,
  stream: { kind: 'session', id: 'session-a' }, payload_type: type, durability, payload });

describe('Muse owned worker', () => {
  it('keeps the sandbox, disables the paid approval judge and pins resume arguments', () => {
    const args = museWorkerArgs({ prompt: 'literal ; $(false)', model: 'muse-wonder', effort: 'high', threadId: 'session-a' });
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--provider', 'meta', '--session-id', 'session-a', '--model', 'muse-wonder', '--reasoning-effort', 'high', '--approval-judge', 'off']));
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--disable-sandbox');
    expect(args.at(-1)).toBe('literal ; $(false)');
  });

  it('does not count intake, background child completion, or ephemeral status as turn success', () => {
    const raw = [frame('runtime.command.accepted', {}), frame('task.lifecycle.completed', {}),
      frame('run.terminal.completed', { terminal: 'completed', text: 'not durable' }, 'ephemeral')].join('\n');
    expect(parseMuseRunLog(raw, run).completedTurn).toBe(false);
  });

  it('passes each tool server with the native CLI per-server configuration shape', () => {
    const args = museWorkerArgs({ prompt: 'task', workerMcpServers: [{ name: 'fixture', command: '/fixture/server', args: ['literal ; $(false)'], env: {} } as never] });
    const value = args[args.indexOf('-c') + 1];
    expect(value).toBe('mcp_servers.fixture={"command":"/fixture/server","args":["literal ; $(false)"],"env":{},"transport":"stdio","enabled":true,"mode":"required"}');
    expect(() => museWorkerArgs({ prompt: 'task', workerMcpServers: [{ name: 'bad.name' } as never] })).toThrow();
  });

  it('discovers the native session and folds streamed answer once at its durable terminal', () => {
    const raw = [frame('session.run.linked', {}), frame('run.output.delta', { delta: 'Answer' }, 'ephemeral'),
      frame('run.terminal.completed', { terminal: 'completed', text: 'Answer' })].join('\n');
    const parsed = parseMuseRunLog(raw, run);
    expect(parsed.threadId).toBe('session-a');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.entries.filter(value => value.kind === 'message').map(value => value.text)).toEqual(['Answer']);
  });

  it('preserves a failed terminal even when the child process exits cleanly', () => {
    const parsed = parseMuseRunLog(frame('run.terminal.failed', { terminal: 'failed', reason: 'modelError' }), run);
    expect(parsed.completedTurn).toBe(false);
    expect(parsed.providerFailure).toBeDefined();
  });
});
