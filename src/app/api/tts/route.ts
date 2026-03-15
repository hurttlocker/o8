/**
 * POST /api/tts — Server-side TTS via edge-tts (Python).
 *
 * Browser can't set custom headers on WebSocket, and Microsoft now
 * requires DRM headers (Sec-MS-GEC token + MUID cookie). So we run
 * edge-tts server-side and stream the MP3 back.
 *
 * Body: { text: string, voice?: string }
 * Returns: audio/mpeg stream
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';

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

    // Run edge-tts CLI and capture MP3 output
    const mp3 = await runEdgeTTS(trimmedText, voice);

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
