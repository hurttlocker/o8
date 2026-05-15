#!/usr/bin/env tsx
/**
 * One-shot billing smoke for interactive Claude Code sessions.
 *
 * Run with:
 *   npx tsx scripts/verify-claude-interactive-billing.ts
 *
 * This intentionally starts a real interactive session, sends one trivial
 * message, and verifies the CLI telemetry that distinguishes subscription
 * billing from programmatic API-key billing.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

type JsonRecord = Record<string, unknown>;

interface Observations {
  apiKeySource: string | null;
  apiKeySourceEvent: JsonRecord | null;
  rateLimitType: string | null;
  rateLimitEvent: JsonRecord | null;
  turnCompleted: boolean;
  jsonEvents: number;
  stderrTail: string;
}

const EXPECTED_API_KEY_SOURCE = 'none';
const EXPECTED_RATE_LIMIT_TYPE = 'five_hour';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MESSAGE = 'Reply with exactly: billing-smoke-ok';

function resolveHomePath(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

function claudeCodeBin(): string {
  const override = process.env.O8_CLAUDE_CODE_BIN?.trim() || process.env.CLAUDE_BIN?.trim();
  if (override) return resolveHomePath(override);

  const localBin = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(localBin) ? localBin : 'claude';
}

function smokeCwd(): string {
  const rawCwd = process.env.CLAUDE_BILLING_SMOKE_CWD?.trim();
  return rawCwd ? resolve(resolveHomePath(rawCwd)) : process.cwd();
}

function timeoutMs(): number {
  const rawTimeout = Number(process.env.CLAUDE_BILLING_SMOKE_TIMEOUT_MS);
  return Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringAtPath(record: JsonRecord, path: string[]): string | null {
  let cursor: unknown = record;
  for (const key of path) {
    const parent = asRecord(cursor);
    if (!parent) return null;
    cursor = parent[key];
  }
  return asString(cursor);
}

function compactJson(record: JsonRecord | null): string {
  if (!record) return 'not observed';
  try {
    const json = JSON.stringify(record);
    return json.length > 1_000 ? `${json.slice(0, 1_000)}...` : json;
  } catch {
    return '[unserializable event]';
  }
}

function isSystemInit(event: JsonRecord): boolean {
  const type = asString(event.type);
  const subtype = asString(event.subtype);
  return type === 'system/init' || (type === 'system' && subtype === 'init');
}

function isRateLimitEvent(event: JsonRecord): boolean {
  const type = asString(event.type);
  const subtype = asString(event.subtype);
  return (
    type === 'rate_limit_event'
    || type === 'system/rate_limit_event'
    || (type === 'system' && (subtype === 'rate_limit_event' || subtype === 'rate_limit'))
    || Boolean(asRecord(event.rate_limit_event) || asRecord(event.rateLimitEvent))
  );
}

function apiKeySourceFromEvent(event: JsonRecord): string | null {
  return (
    stringAtPath(event, ['apiKeySource'])
    ?? stringAtPath(event, ['api_key_source'])
    ?? stringAtPath(event, ['data', 'apiKeySource'])
    ?? stringAtPath(event, ['data', 'api_key_source'])
  );
}

function rateLimitTypeFromEvent(event: JsonRecord): string | null {
  return (
    stringAtPath(event, ['rateLimitType'])
    ?? stringAtPath(event, ['rate_limit_type'])
    ?? stringAtPath(event, ['rateLimitEvent', 'rateLimitType'])
    ?? stringAtPath(event, ['rateLimitEvent', 'rate_limit_type'])
    ?? stringAtPath(event, ['rate_limit_event', 'rateLimitType'])
    ?? stringAtPath(event, ['rate_limit_event', 'rate_limit_type'])
    ?? stringAtPath(event, ['data', 'rateLimitType'])
    ?? stringAtPath(event, ['data', 'rate_limit_type'])
  );
}

function observeEvent(event: JsonRecord, observations: Observations): void {
  observations.jsonEvents += 1;
  const type = asString(event.type);

  if (isSystemInit(event)) {
    observations.apiKeySource = apiKeySourceFromEvent(event);
    observations.apiKeySourceEvent = event;
  }

  if (isRateLimitEvent(event)) {
    observations.rateLimitType = rateLimitTypeFromEvent(event);
    observations.rateLimitEvent = event;
  }

  if (type === 'message_stop' || type === 'result') {
    observations.turnCompleted = true;
  }
}

function hasPassingTelemetry(observations: Observations): boolean {
  return (
    observations.apiKeySource === EXPECTED_API_KEY_SOURCE
    && observations.rateLimitType === EXPECTED_RATE_LIMIT_TYPE
    && observations.turnCompleted
  );
}

function missingTelemetryMessage(observations: Observations): string {
  return [
    `expected system/init apiKeySource=${JSON.stringify(EXPECTED_API_KEY_SOURCE)}; observed ${JSON.stringify(observations.apiKeySource)}`,
    `expected rate_limit_event rateLimitType=${JSON.stringify(EXPECTED_RATE_LIMIT_TYPE)}; observed ${JSON.stringify(observations.rateLimitType)}`,
    `expected one completed interactive turn; observed ${observations.turnCompleted ? 'complete' : 'incomplete'}`,
    `parsed JSON events: ${observations.jsonEvents}`,
    `system/init event: ${compactJson(observations.apiKeySourceEvent)}`,
    `rate_limit_event: ${compactJson(observations.rateLimitEvent)}`,
    observations.stderrTail.trim() ? `stderr tail: ${observations.stderrTail.trim()}` : null,
  ].filter(Boolean).join('\n');
}

function parseJsonLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function terminate(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 2_000).unref();
}

async function runSmoke(): Promise<Observations> {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (args.includes('-p') || args.includes('--print')) {
    throw new Error('Billing smoke must use interactive Claude Code, not -p/--print');
  }

  const observations: Observations = {
    apiKeySource: null,
    apiKeySourceEvent: null,
    rateLimitType: null,
    rateLimitEvent: null,
    turnCompleted: false,
    jsonEvents: 0,
    stderrTail: '',
  };

  const bin = claudeCodeBin();
  const cwd = smokeCwd();
  console.log(`[billing-smoke] spawning: ${bin} ${args.join(' ')}`);
  console.log(`[billing-smoke] cwd: ${cwd}`);

  const proc = spawn(bin, args, {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      O8_MANAGED_SESSION: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const stderr = createInterface({ input: proc.stderr, crlfDelay: Infinity });

  return new Promise<Observations>((resolvePromise, rejectPromise) => {
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.close();
      stderr.close();
      terminate(proc);
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(observations);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${timeoutMs()}ms\n${missingTelemetryMessage(observations)}`));
    }, timeoutMs());

    proc.on('error', (error) => {
      finish(error);
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      finish(new Error(`claude exited before billing telemetry passed (${suffix})\n${missingTelemetryMessage(observations)}`));
    });

    const handleLine = (line: string) => {
      const event = parseJsonLine(line);
      if (!event) return;
      observeEvent(event, observations);
      if (hasPassingTelemetry(observations)) {
        finish(null);
      }
    };

    stdout.on('line', handleLine);
    stderr.on('line', (line) => {
      observations.stderrTail = `${observations.stderrTail}${line}\n`.slice(-4_000);
      handleLine(line);
    });

    const message = process.env.CLAUDE_BILLING_SMOKE_MESSAGE?.trim() || DEFAULT_MESSAGE;
    const payload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: message,
      },
    })}\n`;

    proc.stdin.write(payload, 'utf8', (error?: Error | null) => {
      if (error) finish(error);
    });
  });
}

async function main(): Promise<void> {
  try {
    const observations = await runSmoke();
    console.log('PASS billing-smoke');
    console.log(`  system/init apiKeySource: ${observations.apiKeySource}`);
    console.log(`  rate_limit_event rateLimitType: ${observations.rateLimitType}`);
    console.log(`  completed interactive turn: ${observations.turnCompleted}`);
    console.log('  Operator follow-up: compare the Anthropic usage dashboard before scaling interactive sessions.');
  } catch (error) {
    console.error('FAIL billing-smoke');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
