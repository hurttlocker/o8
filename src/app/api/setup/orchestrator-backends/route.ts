/**
 * Orchestrator-backend availability — drives which backends the desktop picker
 * offers. Today only the ACP-based Hermes backend needs a presence check (its
 * binary may not be installed); the built-in codex/claude/openclaw are always
 * available. GET-only, under the setup read-only allowlist.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

import { isHermesAvailable, isOpencodeAcpAvailable } from '@/lib/lane/orchestrator-backends/acp';

export async function GET() {
  try {
    return NextResponse.json({ hermes: isHermesAvailable(), opencode: isOpencodeAcpAvailable() });
  } catch (error) {
    return NextResponse.json(
      { hermes: false, opencode: false, error: error instanceof Error ? error.message : String(error) },
      { status: 200 },
    );
  }
}
