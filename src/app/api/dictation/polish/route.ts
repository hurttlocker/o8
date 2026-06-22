export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import {
  buildPolishSystemPrompt,
  type DictationPolishContext,
  type DictationSurface,
} from '@/lib/dictation/polish-prompt';
import { processVoiceCommands } from '@/lib/dictation/voice-commands';

// Polish runs on Gemini Flash Lite. NOTE (2026-06-22): the former primary
// `google/gemini-flash-lite-latest` is NO LONGER a valid OpenRouter model id
// ("is not a valid model ID") — it failed EVERY call and forced a wasted
// round-trip before the fallback, a major source of polish slowness. Lead with
// the verified-working `gemini-2.5-flash-lite` (0.37s, ~$0.00005/polish in the
// founder-polish-sweep); deepseek-chat is a working fallback. Both keep meaning
// (OUTPUT COVERAGE guard) — re-verify any new id with scripts/founder-polish-sweep.mjs.
const POLISH_MODELS = ['google/gemini-2.5-flash-lite', 'deepseek/deepseek-chat'];

interface PolishRequestBody {
  transcript?: string;
  surface?: DictationSurface;
  context?: DictationPolishContext;
}

/**
 * POST /api/dictation/polish
 *
 * Cleans up a raw Whisper transcript using a Gemini Flash Lite call
 * with the dev-aware adaptive-punctuation prompt from polish-prompt.ts.
 * Voice commands ("cancel", "scratch that", "remove that", "new line")
 * are processed deterministically before polish — saves an LLM call on
 * the most common cancellation phrases.
 *
 * Returns `{ text }` (polished text or empty if cancelled by voice).
 */
export async function POST(request: Request) {
  let body: PolishRequestBody;
  try {
    body = await request.json() as PolishRequestBody;
  } catch {
    return NextResponse.json({ error: 'Expected JSON body.' }, { status: 400 });
  }

  const transcript = (body.transcript ?? '').trim();
  if (!transcript) {
    return NextResponse.json({ text: '' });
  }

  // Deterministic pre-pass: catch cancellations + insert literal newlines.
  const command = processVoiceCommands(transcript);
  if (command.kind === 'cancel') {
    return NextResponse.json({ text: '', cancelled: true, reason: command.reason });
  }
  const preCleaned = command.text;

  const surface: DictationSurface = body.surface ?? 'general';
  const systemPrompt = buildPolishSystemPrompt(surface, body.context ?? {});

  const route = await resolveOpenRouterRoute();
  if (!route) {
    // Polish is best-effort — with no key AND no plan token, return the
    // pre-cleaned transcript so the user still gets text inserted, just
    // unpolished. A plan token routes this through the proxy.
    return NextResponse.json({ text: preCleaned, polished: false });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `RAW TRANSCRIPT:\n${preCleaned}` },
  ];

  const failures: string[] = [];
  for (const model of POLISH_MODELS) {
    try {
      const response = await fetch(route.url, {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify({
          model,
          messages,
          // Gemini Flash silently truncates long inputs without an
          // explicit cap. 16k matches Symon's mitigation.
          max_tokens: 16_384,
          temperature: 0.2,
        }),
        // Bound each upstream call (polish loops over 2 models → 60s worst
        // case). Polish is best-effort and falls back to the raw transcript,
        // so a per-model timeout just skips cleanup rather than hanging.
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${model}: HTTP ${response.status} ${text.slice(0, 160)}`);
        continue;
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      const polished = parsed.choices?.[0]?.message?.content?.trim() ?? '';
      if (!polished && parsed.error?.message) {
        failures.push(`${model}: ${parsed.error.message.slice(0, 160)}`);
        continue;
      }
      return NextResponse.json({ text: polished || preCleaned, polished: Boolean(polished) });
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // All models failed — fall back to the pre-cleaned transcript so the
  // user still gets text. Surface the failure detail in the response so
  // the client can warn-toast.
  return NextResponse.json({
    text: preCleaned,
    polished: false,
    error: `Polish failed across all models. ${failures.join('; ')}`,
  });
}
