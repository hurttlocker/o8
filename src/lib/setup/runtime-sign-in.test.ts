import { expect, it } from 'vitest';
import { getRuntimeSignInInfo } from './runtime-sign-in';
import type { SetupRuntime } from './runtime-recommendation';

const runtime = (id: SetupRuntime['id'], patch: Partial<SetupRuntime> = {}): SetupRuntime => ({
  id, label: id, available: false, unavailableReason: 'needs_auth', detail: '', fix: '', ...patch,
});
it('uses supported commands and never treats remediation text as a command', () => {
  expect(getRuntimeSignInInfo(runtime('codex', { fix: 'Run `unexpected-command --unsafe`.' }))?.command).toBe('codex login');
  expect(getRuntimeSignInInfo(runtime('claude-code'))?.command).toBe('claude');
  expect(getRuntimeSignInInfo(runtime('opencode'))?.command).toBe('opencode2 auth login');
  expect(getRuntimeSignInInfo(runtime('cursor'))?.command).toBe('cursor-agent login');
  expect(getRuntimeSignInInfo(runtime('grok', { fix: 'Set up your provider.' }))).toEqual({ instruction: 'Set up your provider.' });
});
it('uses the worker connection entry point when Claude needs its dedicated credential', () => {
  expect(getRuntimeSignInInfo(runtime('claude-code', { fix: 'Run `o8 worker login` in an operator terminal.' }))?.command).toBe('o8 worker login');
  expect(getRuntimeSignInInfo(runtime('codex', { fix: 'Run `o8 worker login`.' }))?.command).toBe('codex login');
});
it('keeps ready, missing, restarted, and built-in runtimes out of sign-in recovery', () => {
  expect(getRuntimeSignInInfo(runtime('codex', { available: true }))).toBeNull();
  expect(getRuntimeSignInInfo(runtime('codex', { unavailableReason: 'not_installed' }))).toBeNull();
  expect(getRuntimeSignInInfo(runtime('opencode', { unavailableReason: 'needs_restart' }))).toBeNull();
  expect(getRuntimeSignInInfo(runtime('pi', { builtIn: { backend: 'o8', planDetail: 'Included model' } }))).toBeNull();
});
