/**
 * Cortex Action API — Run safe Cortex maintenance + fact resolution commands.
 *
 * GET  /api/v2/cortex/action?command=conflicts%20--json%20--limit%2020
 * POST { command: "cleanup" | "lifecycle run" | "conflicts --limit 10" | "conflicts --json --limit 20" | "optimize" | "stats" | "doctor" | "fact keep <id>" | "fact drop <id>" }
 */

import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORTEX_BIN = process.env.CORTEX_BINARY || join(process.env.HOME || '/Users/marquisehurtt', 'bin', 'cortex');

const EXACT_COMMANDS = new Map<string, string[]>([
  ['cleanup', ['cleanup']],
  ['lifecycle run', ['lifecycle', 'run']],
  ['conflicts --limit 10', ['conflicts', '--limit', '10']],
  ['conflicts --json --limit 20', ['conflicts', '--json', '--limit', '20']],
  ['optimize', ['optimize']],
  ['stats', ['stats']],
  ['doctor', ['doctor']],
]);

function normalizeCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  const normalized = command.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function parseCommandArgs(command: unknown): string[] | null {
  const normalized = normalizeCommand(command);
  if (!normalized) return null;

  const exact = EXACT_COMMANDS.get(normalized);
  if (exact) return exact;

  const factMatch = normalized.match(/^fact\s+(keep|drop)\s+(\d+)$/);
  if (factMatch) {
    return ['fact', factMatch[1], factMatch[2]];
  }

  return null;
}

function parseOutput(output: string): unknown {
  if (!output) return '';
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function runCortexCommand(command: unknown) {
  const normalized = normalizeCommand(command);
  const args = parseCommandArgs(normalized);

  if (!normalized || !args) {
    const allowed = [...EXACT_COMMANDS.keys(), 'fact keep <id>', 'fact drop <id>'].join(', ');
    return NextResponse.json(
      { error: `Command not allowed. Allowed: ${allowed}` },
      { status: 400 }
    );
  }

  const result = spawnSync(CORTEX_BIN, args, {
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.error) {
    return NextResponse.json(
      { error: result.error.message || String(result.error) },
      { status: 500 }
    );
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status !== 0) {
    const errorText = [stdout, stderr].filter(Boolean).join('\n').trim() || `Command failed with exit code ${result.status}`;
    return NextResponse.json(
      { error: errorText },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, result: parseOutput(stdout || stderr) });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  return runCortexCommand(searchParams.get('command'));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return runCortexCommand(body?.command);
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }
}
