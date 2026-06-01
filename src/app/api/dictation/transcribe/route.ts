export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';

const OPENROUTER_TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const WHISPER_MODEL = 'openai/whisper-large-v3-turbo';

/**
 * POST /api/dictation/transcribe
 *
 * Accepts a multipart upload with field `audio` (any browser-recorded
 * audio blob — webm/opus is the default from MediaRecorder). Forwards
 * to OpenRouter's audio transcriptions endpoint with Whisper Turbo and
 * returns `{ text }`.
 *
 * Returns 503 if no OPENROUTER_API_KEY is configured. Returns the raw
 * provider error text on upstream failures so the client can surface a
 * useful toast.
 */
export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with an `audio` field.' }, { status: 400 });
  }

  const audio = formData.get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: 'Missing or empty `audio` field.' }, { status: 400 });
  }
  // 10 MB is a generous cap. Symon caps at the same size before falling
  // back to FLAC re-encoding; we just reject — at 16 kHz mono webm/opus
  // 10 MB is roughly 30 minutes, more than any push-to-talk session.
  if (audio.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Audio too large (max 10 MB).' }, { status: 413 });
  }

  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'OPENROUTER_API_KEY is not configured. Set it in Settings → Keys to enable dictation.' },
      { status: 503 },
    );
  }

  // OpenRouter's audio transcriptions endpoint expects a JSON body with
  // base64-encoded audio in `input_audio.data`, not multipart. The
  // Symon research called this out — the multipart contract is OpenAI's
  // direct endpoint, not OpenRouter's. Encode here.
  const audioBuffer = Buffer.from(await audio.arrayBuffer());
  const base64Audio = audioBuffer.toString('base64');
  // Map browser MediaRecorder mimes to OpenRouter format names.
  const mimeType = (audio.type || '').toLowerCase();
  const audioFormat = mimeType.includes('webm')
    ? 'webm'
    : mimeType.includes('mp4') || mimeType.includes('m4a')
      ? 'mp4'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : 'webm';

  let response: Response;
  try {
    response = await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://o8.app',
        'X-Title': 'o8 Dictation',
      },
      body: JSON.stringify({
        model: WHISPER_MODEL,
        input_audio: { data: base64Audio, format: audioFormat },
        language: 'en',
        temperature: 0,
      }),
      // Bound the upstream call so a hung provider request can't freeze the
      // dictation pill indefinitely (it has no client-side abort). Matches the
      // QA openrouter-adapter pattern. AbortSignal.timeout throws a TimeoutError
      // into the catch below → structured 502.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    return NextResponse.json({ error: `Transcribe network error: ${message}` }, { status: 502 });
  }

  const raw = await response.text();
  if (!response.ok) {
    // 402 = the OpenRouter account is out of credits. Surface an actionable
    // operator message instead of the raw provider text (which can also carry
    // an account user_id).
    if (response.status === 402) {
      return NextResponse.json(
        { error: 'Dictation provider is out of credits — top up OpenRouter in Settings → Keys.' },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `Transcribe upstream error (${response.status}): ${raw.slice(0, 240)}` },
      { status: 502 },
    );
  }

  let text = '';
  try {
    const parsed = JSON.parse(raw) as { text?: string; error?: { message?: string } };
    text = parsed.text?.trim() ?? '';
    if (!text && parsed.error?.message) {
      return NextResponse.json({ error: parsed.error.message.slice(0, 240) }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: 'Transcribe response was not JSON.' }, { status: 502 });
  }

  return NextResponse.json({ text });
}
