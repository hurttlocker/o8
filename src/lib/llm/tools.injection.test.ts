import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand, executeTool } from './tools';

// Regression guard for SECURITY_AUDIT_2026-07-02 §HIGH-2: search_code / list_files
// must pass query/pattern as argv tokens (execFile), never a shell string.
describe('search_code / list_files command injection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'o8-inject-repo-'));
  writeFileSync(join(repo, 'a.ts'), 'const greeting = "hello world";\n');

  it('does NOT execute a shell subshell in the query (was $(…) injection)', async () => {
    const sentinel = join(tmpdir(), `o8-inject-sentinel-${repo.split('-').pop()}-q`);
    rmSync(sentinel, { force: true });
    await executeTool('search_code', { query: `$(touch ${sentinel})` }, repo);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('does NOT execute a shell metacharacter break-out in filePattern', async () => {
    const sentinel = join(tmpdir(), `o8-inject-sentinel-${repo.split('-').pop()}-fp`);
    rmSync(sentinel, { force: true });
    await executeTool('search_code', { query: 'greeting', filePattern: `*.ts"; touch ${sentinel}; echo "` }, repo);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('does NOT execute an injected command in list_files pattern', async () => {
    const sentinel = join(tmpdir(), `o8-inject-sentinel-${repo.split('-').pop()}-lf`);
    rmSync(sentinel, { force: true });
    await executeTool('list_files', { pattern: `*.ts"; touch ${sentinel}; echo "` }, repo);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('still performs a normal code search (functionality intact)', async () => {
    const res = await executeTool('search_code', { query: 'greeting' }, repo);
    expect(res.content).toContain('a.ts');
  });
});

describe('terminal command approval classification', () => {
  it.each([
    'env',
    'cat ~/.o8/ws-token',
    'echo $OPENAI_API_KEY',
    'echo ok; touch /tmp/o8-proof',
    'find / -name id_rsa',
    'git status',
  ])('requires approval for %s', (command) => {
    expect(classifyCommand(command).safety).toBe('needs_approval');
  });

  it('still blocks destructive shell commands', () => {
    expect(classifyCommand('rm -rf /tmp/example').safety).toBe('blocked');
  });
});
