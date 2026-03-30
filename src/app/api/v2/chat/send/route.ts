export const dynamic = 'force-dynamic';

/**
 * POST /api/v2/chat/send
 *
 * Unified chat send — single endpoint for all LLM chat.
 * Routes based on user plan:
 *   - BYOK / self-hosted → pass through to /api/v2/proxy/llm (uses user's own API keys)
 *   - Managed (subscriber) → same proxy route but uses our platform keys + meters tokens
 *   - Local runtime (Codex/Claude Code) → routes to respective runtime send endpoint
 *
 * The legacy routes stay for backward compat:
 *   - /api/claude-code/send
 *   - /api/codex/send
 *
 * Body: {
 *   target: 'llm' | 'codex' | 'claude-code',
 *   model?: string,
 *   provider?: 'anthropic' | 'openai' | 'google',
 *   messages?: Message[],
 *   sessionKey?: string,
 *   message?: string,
 *   approvedTools?: string[],
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';

export const POST = withOptionalAuth(async (request: NextRequest, auth: AuthContext | null) => {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const target: string = body.target ?? 'llm';
  const baseUrl = request.nextUrl.origin;

  // ── Route 1: LLM Chat (direct model access via proxy) ──
  if (target === 'llm') {
    if (!body.model || !body.provider || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: 'model, provider, and messages are required for target=llm' },
        { status: 400 },
      );
    }

    // Forward to the proxy route — it handles BYOK vs managed, streaming, tools, memory
    const proxyRes = await fetch(`${baseUrl}/api/v2/proxy/llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forward auth if present
        ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        // Forward tab ID for memory extraction
        ...(request.headers.get('x-tab-id') ? { 'x-tab-id': request.headers.get('x-tab-id')! } : {}),
      },
      body: JSON.stringify({
        model: body.model,
        provider: body.provider,
        messages: body.messages,
        approvedTools: body.approvedTools,
      }),
    });

    // Stream the response through (SSE passthrough)
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: {
        'Content-Type': proxyRes.headers.get('Content-Type') ?? 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // ── Route 2: Codex CLI ──
  if (target === 'codex') {
    if (!body.message) {
      return NextResponse.json(
        { error: 'message is required for target=codex' },
        { status: 400 },
      );
    }

    const res = await fetch(`${baseUrl}/api/codex/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: body.message,
        threadId: body.threadId ?? body.sessionKey,
        cwd: body.cwd,
      }),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  // ── Route 3: Claude Code CLI ──
  if (target === 'claude-code') {
    if (!body.message) {
      return NextResponse.json(
        { error: 'message is required for target=claude-code' },
        { status: 400 },
      );
    }

    const res = await fetch(`${baseUrl}/api/claude-code/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: body.message,
        sessionId: body.sessionId ?? body.sessionKey,
        cwd: body.cwd,
      }),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json(
    { error: `Unknown target: ${target}. Use llm, codex, or claude-code.` },
    { status: 400 },
  );
});
