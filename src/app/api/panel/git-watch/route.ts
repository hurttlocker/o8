/**
 * SSE endpoint that watches a workspace's `.git/HEAD` and `.git/index` files
 * and emits a `changed` event whenever either is touched.
 *
 * Used by the right-side Changes panel to refresh after `git commit` runs in
 * any terminal (embedded or external). Avoids tight polling — the watcher is
 * filesystem-driven and only fires on real git activity.
 *
 * Watches HEAD (branch refs / detached state) and index (staged files) so we
 * catch every commit, checkout, reset, stash, etc. Debounced 200ms to coalesce
 * the multi-write burst that git emits per command.
 */

import { NextRequest } from 'next/server';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEBOUNCE_MS = 200;
const PING_INTERVAL_MS = 25_000;

function resolveWorkspace(input: string): string {
  if (input.startsWith('~')) {
    return input.replace('~', homedir());
  }
  return input;
}

export async function GET(request: NextRequest) {
  const workspaceParam = request.nextUrl.searchParams.get('workspace')?.trim();
  if (!workspaceParam) {
    return new Response(JSON.stringify({ error: 'workspace is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const workspace = resolveWorkspace(workspaceParam);
  const gitDir = join(workspace, '.git');
  const headPath = join(gitDir, 'HEAD');
  const indexPath = join(gitDir, 'index');

  if (!existsSync(gitDir)) {
    return new Response(JSON.stringify({ error: 'workspace is not a git repo' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];
  let closed = false;

  const readable = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // stream closed mid-send — ignore
        }
      };

      send('connected', { workspace, ts: Date.now() });

      const scheduleEmit = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          send('changed', { ts: Date.now() });
        }, DEBOUNCE_MS);
      };

      const attach = (target: string) => {
        if (!existsSync(target)) return;
        try {
          const watcher = watch(target, () => {
            scheduleEmit();
          });
          watcher.on('error', () => {
            // Single-file watch can drop on rename/atomic write — ignore;
            // the .git dir watch below catches the recreation.
          });
          watchers.push(watcher);
        } catch {
          // Best-effort. If watch fails the panel still has its manual refresh.
        }
      };

      attach(headPath);
      attach(indexPath);

      // Watch the .git directory itself — git often replaces HEAD/index via
      // atomic rename (write to .lock, rename over). The single-file watcher
      // can lose its target on rename, so we keep the dir-level watch as a
      // backstop and re-emit when HEAD or index changes name.
      try {
        const dirWatcher = watch(gitDir, (_eventType, fileName) => {
          const name = fileName?.toString();
          if (name === 'HEAD' || name === 'index') {
            scheduleEmit();
          }
        });
        dirWatcher.on('error', () => { /* ignore */ });
        watchers.push(dirWatcher);
      } catch {
        // ignore
      }

      pingTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`),
          );
        } catch {
          // ignore stream closure races
        }
      }, PING_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      watchers.length = 0;
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
