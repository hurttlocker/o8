/**
 * POST /api/cortex/ask  (#915 sub-4 — UI scaffold)
 *
 * Mocked Server-Sent Events stream for the Ask Anything surface on the
 * Recall Card. The real composer lands in #915 sub-2 (Wave B); until then
 * this route emits a hardcoded sequence so the UI can be wired and demoed
 * end-to-end.
 *
 * Request body:
 *   { question: string, repoPath?: string, mode?: 'brain' | 'memory' }
 *
 * Response:
 *   text/event-stream with named SSE events:
 *     - event: token        — { text: string }
 *     - event: citation     — { kind, rowId, excerpt, url? }
 *     - event: contradiction — { directiveId, outcomeId, summary }
 *     - event: done         — {}
 *
 * Header `X-Mock: true` is always set so callers can tell scaffold output
 * apart from the real composer.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';

interface AskBody {
  question?: unknown;
  repoPath?: unknown;
  mode?: unknown;
}

interface MockCitation {
  kind: 'directive' | 'outcome' | 'pr' | 'issue' | 'symbol';
  rowId: string;
  excerpt: string;
  url?: string;
}

interface MockContradiction {
  directiveId: string;
  outcomeId: string;
  summary: string;
}

interface MockScript {
  tokens: string[];
  citations: MockCitation[];
  contradiction: MockContradiction | null;
}

function buildMockScript(question: string): MockScript {
  // The streamed answer interleaves prose with `[CITATION:<rowId>]`
  // markers so the AnswerStream can splice <CitationPill>s inline.
  const q = question.trim();
  const isJwtQuestion = /jwt|session|auth/i.test(q);

  if (isJwtQuestion) {
    return {
      tokens: [
        'We chose ',
        'JWT ',
        'as the authentication primitive in directive ',
        '[CITATION:D-014]',
        '. ',
        'A later outcome in ',
        '[CITATION:O-481]',
        ' partially reverted that decision for the mobile path. ',
        'The merge in ',
        '[CITATION:PR-650]',
        ' shipped session cookies for `/api/v2/auth` only.',
      ],
      citations: [
        {
          kind: 'directive',
          rowId: 'D-014',
          excerpt: 'JWT everywhere — short-lived access + refresh tokens.',
        },
        {
          kind: 'outcome',
          rowId: 'O-481',
          excerpt: 'Mobile shipped session cookies for /api/v2/auth.',
        },
        {
          kind: 'pr',
          rowId: 'PR-650',
          excerpt: 'feat(mobile): switch /api/v2/auth to session cookies',
          url: 'https://github.com/hurttlocker/cortex-ide/pull/650',
        },
      ],
      contradiction: {
        directiveId: 'D-014',
        outcomeId: 'O-481',
        summary:
          'D-014 still says "JWT everywhere" but O-481 shipped session cookies for /api/v2/auth. Resolve in directive?',
      },
    };
  }

  // Generic fallback so any question still streams something believable.
  return {
    tokens: [
      'Based on the most recent directives and outcomes, ',
      'the answer hinges on ',
      '[CITATION:D-014]',
      ' and the live state captured in ',
      '[CITATION:O-481]',
      '. ',
      'See ',
      '[CITATION:PR-650]',
      ' for the implementation that landed last.',
    ],
    citations: [
      {
        kind: 'directive',
        rowId: 'D-014',
        excerpt: 'Top-priority directive for this repo.',
      },
      {
        kind: 'outcome',
        rowId: 'O-481',
        excerpt: 'Most recent successful outcome on this repo.',
      },
      {
        kind: 'pr',
        rowId: 'PR-650',
        excerpt: 'Most recent merged PR touching this area.',
        url: 'https://github.com/hurttlocker/cortex-ide/pull/650',
      },
    ],
    contradiction: null,
  };
}

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AskBody | null;
  const question = typeof body?.question === 'string' ? body.question : '';
  if (!question.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'question is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const script = buildMockScript(question);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (name: string, payload: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(name, payload)));
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      try {
        // Heartbeat-like opener so any keep-alive proxy flushes.
        send('open', { ok: true, mock: true });

        for (const chunk of script.tokens) {
          send('token', { text: chunk });
          await sleep(45);
        }
        for (const citation of script.citations) {
          send('citation', citation);
        }
        if (script.contradiction) {
          send('contradiction', script.contradiction);
        }
        send('done', {});
      } catch (err) {
        const message = err instanceof Error ? err.message : 'mock stream error';
        send('error', { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Mock': 'true',
    },
  });
}
