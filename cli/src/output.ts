/**
 * Output module — JSON to stdout by default, --human for pretty ANSI.
 *
 * Agents are the primary audience: JSON output stays stable, errors land on
 * stderr never stdout. Humans get the fallback `--human` formatting.
 */

import { CliError, EXIT, type ExitCode } from './api.js';

export interface OutputMode {
  human: boolean;
  verbose: boolean;
}

export function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function printError(err: unknown, mode: OutputMode): ExitCode {
  if (err instanceof CliError) {
    const body = {
      schema: 'o8/cli/error/v1',
      error: {
        code: err.code,
        message: err.message,
        hint: err.hint ?? null,
        ambiguous: err.ambiguous,
      },
    };
    if (mode.human) {
      process.stderr.write(`error: ${err.code}\n`);
      process.stderr.write(`  ${err.message}\n`);
      if (err.hint) process.stderr.write(`  hint: ${err.hint}\n`);
      if (err.ambiguous) process.stderr.write('  outcome: ambiguous — the operation may have landed\n');
    } else {
      process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
    }
    return err.exit;
  }
  const message = err instanceof Error ? err.message : String(err);
  const body = {
    schema: 'o8/cli/error/v1',
    error: { code: 'unexpected', message, hint: null, ambiguous: false },
  };
  if (mode.human) {
    process.stderr.write(`error: unexpected\n  ${message}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  }
  return EXIT.INVALID_ARGS;
}

// ── Human-mode helpers ──

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export function color(s: string, ansi: keyof typeof ANSI): string {
  if (!process.stdout.isTTY) return s;
  return `${ANSI[ansi]}${s}${ANSI.reset}`;
}

export function printHumanKv(rows: Array<[string, string]>): void {
  const maxKey = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
  for (const [k, v] of rows) {
    process.stdout.write(`${k.padEnd(maxKey)}  ${v}\n`);
  }
}

export function printHumanHeading(text: string): void {
  process.stdout.write(`\n${color(text, 'bold')}\n`);
}
