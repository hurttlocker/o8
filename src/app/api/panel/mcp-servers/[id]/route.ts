export const dynamic = 'force-dynamic';

/**
 * Panel-gated single MCP server operations.
 *
 * DELETE /api/panel/mcp-servers/[id] — remove a registered server
 *
 * Closes #519.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { removeExternalMcpServer } from '@/lib/mcp/external-servers';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { id } = await params;
  if (!id?.trim()) {
    return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
  }

  try {
    const removed = removeExternalMcpServer(id);
    if (!removed) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove MCP server' },
      { status: 500 },
    );
  }
}
