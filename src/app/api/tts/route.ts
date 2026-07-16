/**
 * POST /api/tts — Server-side Edge neural TTS (Steffan et al).
 *
 * Browser can't set custom headers on WebSocket (Sec-MS-GEC etc.), so the
 * server synthesizes and streams the MP3 back. Primary tier is the NATIVE
 * Node client (lib/tts/edge-neural.ts — zero machine deps); the Python
 * edge-tts CLI remains as a fallback tier only (it requires a pip install
 * that fresh machines don't have — report S9KT8H).
 *
 * Body: { text: string, voice?: string }
 * Returns: audio/mpeg stream
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { synthesizeEdgeNeural } from '@/lib/tts/edge-neural';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text: string = body.text ?? '';
    const voice: string = body.voice ?? 'en-US-SteffanNeural';

    if (!text.trim()) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    // Limit text length to prevent abuse
    const trimmedText = text.slice(0, 10_000);

    // Native Node synthesis first — zero machine deps, works on a fresh
    // laptop (report S9KT8H: the pip-only path silently failed there and the
    // whole product spoke in the `say` Fred voice). The Python CLI stays as
    // the fallback tier for protocol-drift insurance.
    const mp3 = await synthesizeEdgeNeural(trimmedText, voice).catch(async (nativeError: unknown) => {
      console.error('[TTS API] native edge-neural failed, trying python CLI:', nativeError);
      return runEdgeTTS(trimmedText, voice);
    });

    return new NextResponse(mp3, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': mp3.byteLength.toString(),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[TTS API] Error:', err);
    return NextResponse.json(
      { error: 'TTS generation failed', details: String(err) },
      { status: 500 },
    );
  }
}

function runEdgeTTS(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Use edge-tts CLI: writes to stdout with --write-media -
    const proc = spawn('python3', [
      '-m', 'edge_tts',
      '--voice', voice,
      '--text', text,
      '--write-media', '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`edge-tts exited ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn edge-tts: ${err.message}`));
    });
  });
}
