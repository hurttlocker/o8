export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { getGatewayStatus } from '@/lib/openclaw/gateway-client';

const HOME = process.env.HOME || '/Users/marquisehurtt';
const SESSIONS_DIR = join(HOME, '.openclaw/agents/main/sessions');

interface MediaItem {
  path: string;
  name: string;
  mimeType: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'tool';
}

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/**
 * Extract all images from a session's JSONL transcript.
 * Looks for:
 * 1. [media attached: /path/to/file.jpg ...] text patterns
 * 2. content parts with type: 'image' (base64 — we skip data, just note existence)
 * 3. MEDIA: prefixed lines
 */
async function extractSessionMedia(sessionId: string): Promise<MediaItem[]> {
  // Find the JSONL file
  const jsonlPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(jsonlPath)) return [];

  const content = await readFile(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const media: MediaItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'message') continue;

      const msg = entry.message ?? {};
      const ts = entry.timestamp ?? '';
      const role = msg.role ?? 'assistant';
      const msgContent = msg.content;

      // Check string content for [media attached: ...] patterns
      if (typeof msgContent === 'string') {
        const matches = msgContent.matchAll(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\]|]+)/gi);
        for (const match of matches) {
          const filePath = match[1].trim();
          const mime = inferMimeType(filePath);
          if (isImageMime(mime) && !seen.has(filePath)) {
            seen.add(filePath);
            media.push({ path: filePath, name: basename(filePath), mimeType: mime, timestamp: ts, role });
          }
        }
      }

      // Check array content
      if (Array.isArray(msgContent)) {
        for (const part of msgContent) {
          // Text parts may contain media references
          if (part.type === 'text' && typeof part.text === 'string') {
            const matches = part.text.matchAll(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\]|]+)/gi);
            for (const match of matches) {
              const filePath = match[1].trim();
              const mime = inferMimeType(filePath);
              if (isImageMime(mime) && !seen.has(filePath)) {
                seen.add(filePath);
                media.push({ path: filePath, name: basename(filePath), mimeType: mime, timestamp: ts, role });
              }
            }

            // MEDIA: prefix
            const mediaLines = part.text.split('\n').filter((l: string) => l.startsWith('MEDIA:'));
            for (const ml of mediaLines) {
              const filePath = ml.slice('MEDIA:'.length).trim();
              const mime = inferMimeType(filePath);
              if (isImageMime(mime) && !seen.has(filePath)) {
                seen.add(filePath);
                media.push({ path: filePath, name: basename(filePath), mimeType: mime, timestamp: ts, role });
              }
            }
          }

          // Image content parts (base64 stored inline)
          if (part.type === 'image' && part.data) {
            // These are base64 — we can't serve them as URLs easily
            // Create a synthetic identifier
            const key = `base64:${ts}:${media.length}`;
            if (!seen.has(key)) {
              seen.add(key);
              media.push({
                path: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data.slice(0, 100)}...`,
                name: `image-${media.length + 1}.${(part.mimeType ?? 'image/jpeg').split('/')[1] ?? 'jpg'}`,
                mimeType: part.mimeType ?? 'image/jpeg',
                timestamp: ts,
                role,
              });
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return media;
}

/**
 * Resolve session key → session ID.
 * Strategy 1: UUID format → use directly
 * Strategy 2: Scan JSONL files for matching session key in header
 * Strategy 3: Gateway REST API lookup
 */
async function resolveSessionId(sessionKey: string): Promise<string | null> {
  // If it looks like a UUID already, use it directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionKey)) {
    return sessionKey;
  }

  // Strategy 2: Use gateway status to resolve key → ID
  try {
    const status = await getGatewayStatus();
    for (const s of status.sessions.recent) {
      const key = (s.key ?? s.sessionKey ?? '') as string;
      const id = (s.id ?? s.sessionId ?? '') as string;
      if (key === sessionKey && id) return id;
    }
  } catch { /* gateway unavailable */ }

  // Strategy 3: Brute force — scan JSONL files by modification time
  // The most recently modified file for an agent is usually the active session
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
    const sorted = files
      .map(f => ({ file: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    // Return the most recent session as fallback
    if (sorted.length > 0) {
      return sorted[0].file.replace('.jsonl', '');
    }
  } catch { /* scan failed */ }

  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get('sessionKey');

  if (!sessionKey) {
    return NextResponse.json({ error: 'Missing sessionKey' }, { status: 400 });
  }

  try {
    const sessionId = await resolveSessionId(sessionKey);
    if (!sessionId) {
      return NextResponse.json({ media: [], sessionKey, error: 'Session not found' });
    }

    const media = await extractSessionMedia(sessionId);

    // Filter: only serve file-path images (not base64 — those are too large to serve via API)
    const servable = media.filter(m => !m.path.startsWith('data:'));

    return NextResponse.json({
      media: servable,
      total: media.length,
      servable: servable.length,
      sessionKey,
    });
  } catch (error) {
    return NextResponse.json(
      { media: [], sessionKey, error: 'Failed to extract media' },
      { status: 500 },
    );
  }
}
