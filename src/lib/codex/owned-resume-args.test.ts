import { describe, expect, it } from 'vitest';
import { codexResumeArgs } from './owned';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

// `codex exec resume` rejects `-s` (exit 2 before the turn starts) — unlike
// `codex exec`, it has no sandbox short flag. Live-hit 2026-07-05: every
// steer-resume failed silently because the seam test mocked the runtime and
// never validated the real argv contract.
describe('codexResumeArgs — codex exec resume argv contract', () => {
  it('never passes -s / --sandbox to the resume subcommand', () => {
    const args = codexResumeArgs({ threadId: 'thread-1', prompt: 'continue' });
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--sandbox');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it.each([
    ['gpt-5.6-sol', 'high', 'high'],
    ['gpt-5.6-sol', 'ultra', 'ultra'],
    ['gpt-5.6-terra', 'max', 'xhigh'],
  ] as const)('pins the saved model %s and effort %s', (model, effort, expectedEffort) => {
    const args = codexResumeArgs({ threadId: 'thread-1', prompt: 'continue', model, effort });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', model]);
    expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(args.filter((arg) => arg.startsWith('model_reasoning_effort=')))
      .toEqual([`model_reasoning_effort=${expectedEffort}`]);
    expect(args).toContain('--ignore-user-config');
    expect(args.at(-1)).toBe('continue');
  });

  it.each([undefined, 'adaptive'] as Array<ThinkingEffort | undefined>)(
    'preserves default effort behavior for %s',
    (effort) => {
      const args = codexResumeArgs({ threadId: 'thread-1', prompt: 'continue', effort });
      expect(args).not.toContain('--model');
      expect(args.some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);
    },
  );

  it.each(['ollama', 'lmstudio'])('keeps %s provider flags on exec and the model on resume', (provider) => {
    const args = codexResumeArgs({
      threadId: 'thread-local', prompt: 'continue', model: `${provider}:qwen-fixture:32b`, effort: 'high',
    });
    expect(args.slice(0, 6)).toEqual(['exec', '--oss', '--local-provider', provider, 'resume', 'thread-local']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'qwen-fixture:32b']);
    expect(args.slice(args.indexOf('resume'))).not.toContain('--oss');
    expect(args.slice(args.indexOf('resume'))).not.toContain('--local-provider');
    expect(args.at(-1)).toBe('continue');
  });

  it('does not reinterpret a local model name as another provider prefix', () => {
    const args = codexResumeArgs({ threadId: 'thread-local', prompt: 'continue', model: 'ollama:ollama:fixture' });
    expect(args.filter((arg) => arg === '--oss')).toHaveLength(1);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'ollama:fixture']);
  });
});
