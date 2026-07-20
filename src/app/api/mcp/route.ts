import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  handleOperatorMcpMessage,
  type OperatorMcpRequest,
  type OperatorMcpResponse,
} from '@/lib/mcp/operator-mcp-host';
import { setApiBase } from '@/lib/mcp/operator-handlers/shared';
import { getApiBase } from '@/lib/panel/api-port';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonRpcError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32700, message } },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonRpcError('Parse error', 400);
  }

  const isBatch = Array.isArray(payload);
  const messages = (isBatch ? payload : [payload]) as OperatorMcpRequest[];
  if (isBatch && messages.length === 0) return jsonRpcError('Invalid request', 400);

  // Handler modules use the same local HTTP API seam in both transports. The
  // in-app host resolves the live process base here, while the standalone
  // compatibility entrypoint continues to resolve it from ~/.o8/api-port.
  setApiBase(getApiBase());

  const responses: OperatorMcpResponse[] = [];
  for (const message of messages) {
    try {
      const response = await handleOperatorMcpMessage(message);
      if (response) responses.push(response);
    } catch (error) {
      if (message && message.id !== undefined && message.id !== null) {
        responses.push({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (messages.some((message) => message?.method === 'initialize')) {
    headers.set('Mcp-Session-Id', randomUUID());
  }
  if (responses.length === 0) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(isBatch ? responses : responses[0]), { status: 200, headers });
}

// Streamable HTTP permits servers that don't offer a resumable SSE stream to
// reject GET. Tool calls still use POST; the compatibility shim only needs POST.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
}

export function DELETE(): Response {
  return new Response(null, { status: 204 });
}
