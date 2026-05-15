/**
 * One-shot smoke for Claude Code interactive billing routing.
 *
 * Run:
 *   npx tsx scripts/verify-claude-interactive-billing.ts
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = Number(process.env.CLAUDE_BILLING_VERIFY_TIMEOUT_MS ?? 90_000);
const USER_MESSAGE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: 'say hi',
  },
});

interface ParsedEvent {
  raw: Record<string, unknown>;
  type: string | null;
  subtype: string | null;
}

interface RunResult {
  binary: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  events: ParsedEvent[];
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveClaudeBin(): string {
  return expandHome(
    process.env.O8_CLAUDE_CODE_BIN
      || process.env.CLAUDE_BIN
      || '~/.local/bin/claude',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function findStringField(value: unknown, key: string, depth = 0): string | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const direct = stringField(value, key);
  if (direct) return direct;

  for (const child of Object.values(value)) {
    const found = findStringField(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseEventLine(line: string): ParsedEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      raw: parsed,
      type: stringField(parsed, 'type'),
      subtype: stringField(parsed, 'subtype'),
    };
  } catch {
    return null;
  }
}

function tail(value: string, maxChars = 1_200): string {
  if (value.length <= maxChars) return value.trim();
  return value.slice(value.length - maxChars).trim();
}

async function runClaudeInteractive(): Promise<RunResult> {
  const binary = resolveClaudeBin();
  const events: ParsedEvent[] = [];
  let stdout = '';
  let stderr = '';
  let stdoutRemainder = '';
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: unknown) => {
      const text = String(chunk);
      stdout += text;
      stdoutRemainder += text;

      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = parseEventLine(trimmed);
        if (event) events.push(event);
      }
    });

    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(err);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      const trimmed = stdoutRemainder.trim();
      if (trimmed) {
        const event = parseEventLine(trimmed);
        if (event) events.push(event);
      }

      resolve({
        binary,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        events,
      });
    });

    child.stdin.end(`${USER_MESSAGE}\n`);
  });
}

function summarizeAndExit(result: RunResult): never {
  const initApiKeySources = result.events
    .filter((event) => event.type === 'init' || event.type === 'system' || event.subtype === 'init')
    .map((event) => findStringField(event.raw, 'apiKeySource'))
    .filter((value): value is string => Boolean(value));

  const rateLimitTypes = result.events
    .filter((event) => event.type === 'rate_limit_event')
    .map((event) => findStringField(event.raw, 'rateLimitType'))
    .filter((value): value is string => Boolean(value));

  const sawSubscriptionAuth = initApiKeySources.includes('none');
  const sawFiveHourBucket = rateLimitTypes.length > 0
    && rateLimitTypes.every((rateLimitType) => rateLimitType === 'five_hour');
  const exitedCleanly = !result.timedOut && result.exitCode === 0;
  const passed = exitedCleanly && sawSubscriptionAuth && sawFiveHourBucket;

  if (passed) {
    console.log(
      `PASS interactive Claude Code billing smoke: apiKeySource=none; rate_limit_event=five_hour; events=${result.events.length}`,
    );
    process.exit(0);
  }

  console.error('FAIL interactive Claude Code billing smoke');
  console.error(`  binary: ${result.binary}`);
  console.error(`  exit: code=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} timedOut=${result.timedOut}`);
  console.error(`  system/init apiKeySource values: ${initApiKeySources.length ? initApiKeySources.join(', ') : '(none)'}`);
  console.error(`  rate_limit_event rateLimitType values: ${rateLimitTypes.length ? rateLimitTypes.join(', ') : '(none)'}`);
  console.error(`  parsed stdout events: ${result.events.length}`);
  const stderrTail = tail(result.stderr);
  if (stderrTail) console.error(`  stderr tail:\n${stderrTail}`);
  process.exit(1);
}

runClaudeInteractive()
  .then(summarizeAndExit)
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('FAIL interactive Claude Code billing smoke');
    console.error(`  ${message}`);
    process.exit(1);
  });
