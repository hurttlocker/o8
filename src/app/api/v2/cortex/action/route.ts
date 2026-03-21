/**
 * Cortex Action API — Run maintenance commands
 *
 * POST { command: "cleanup" | "lifecycle run" | "conflicts --limit 10" | "optimize" }
 */

import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORTEX_BIN = process.env.CORTEX_BINARY || join(process.env.HOME || '/Users/marquisehurtt', 'bin', 'cortex');

// Only allow safe, known commands
const ALLOWED_COMMANDS = new Set([
  'cleanup',
  'lifecycle run',
  'conflicts --limit 10',
  'optimize',
  'stats',
  'doctor',
]);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { command } = body;

    if (!command || !ALLOWED_COMMANDS.has(command)) {
      return NextResponse.json(
        { error: `Command not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}` },
        { status: 400 }
      );
    }

    const output = execSync(`${CORTEX_BIN} ${command} 2>&1`, {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

    // Try to parse as JSON, otherwise return raw
    let result;
    try {
      result = JSON.parse(output);
    } catch {
      result = output;
    }

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
