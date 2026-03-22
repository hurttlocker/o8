import { NextRequest } from 'next/server';
import {
  seedFromCodebase,
  seedFromGitHistory,
  seedFromText,
} from '@/lib/cortex/seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SeedRequestBody {
  strategy?: 'codebase' | 'git' | 'text';
  repoPath?: string;
  text?: string;
  source?: string;
}

const DEFAULT_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function sseData(payload: unknown): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `data: ${body}\n\n`;
}

export async function POST(request: NextRequest) {
  let body: SeedRequestBody;

  try {
    body = (await request.json()) as SeedRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const strategy = body.strategy;
  if (!strategy || !['codebase', 'git', 'text'].includes(strategy)) {
    return new Response(JSON.stringify({ error: 'strategy must be one of: codebase, git, text' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (strategy === 'text' && !body.text?.trim()) {
    return new Response(JSON.stringify({ error: 'text is required for strategy=text' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const repoPath = body.repoPath?.trim() || DEFAULT_REPO_ROOT;
  const text = body.text?.trim() ?? '';
  const source = body.source?.trim();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const push = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseData(payload)));
        } catch {
          // client disconnected
        }
      };

      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      void (async () => {
        try {
          const onProgress = (message: string) => push({ type: 'progress', message });

          if (strategy === 'codebase') {
            const result = await seedFromCodebase(repoPath, onProgress);
            push({ type: 'complete', ...result });
          } else if (strategy === 'git') {
            const result = await seedFromGitHistory(repoPath, onProgress);
            push({ type: 'complete', ...result });
          } else {
            onProgress('Importing manual text...');
            const result = await seedFromText(text, source);
            push({ type: 'progress', message: `Imported ${result.factsCreated} facts from manual text` });
            push({ type: 'complete', ...result });
          }
        } catch (error) {
          push({
            type: 'error',
            message: error instanceof Error ? error.message : 'Seeding failed',
          });
        } finally {
          push('[DONE]');
          close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
