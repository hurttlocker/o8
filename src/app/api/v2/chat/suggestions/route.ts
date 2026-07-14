export const dynamic = 'force-dynamic';

/**
 * POST /api/v2/chat/suggestions
 *
 * Closes #771 — Augment Intent-style suggested-reply chips.
 *
 * Given the last assistant message + a small slice of prior context, returns
 * 0–3 short suggested user replies. Calls Gemini 2.5 Flash directly (the same
 * cheap free path used by `/api/mobile/enhance`).
 *
 * Empty array means "no useful suggestions" — the UI hides the chip row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeErrorMessage } from '@/lib/api/error-format';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
const GEMINI_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You generate short suggested-reply chips for the next user turn in a coding assistant chat. The user is an engineer talking to an orchestrator AI.

Rules:
- Output STRICT JSON: { "suggestions": string[] }. No prose, no code fences.
- 0 to 3 suggestions, max. Prefer 2-3 when the assistant asked a question or proposed an action; prefer 0 when the assistant is mid-thought, mid-tool-call, or just acknowledging.
- Each suggestion is what the USER would say next. First-person, short (3-7 words), action-oriented.
- Cover distinct intents: an approval/yes path, a concern/pushback, and a clarifying question. Vary across the trio.
- Never echo the assistant. Never quote. No emoji. No trailing punctuation other than question marks.
- If the assistant message is just a status update (e.g., "Working on it…", "Reading file X"), return { "suggestions": [] }.`;

interface SuggestionRequest {
  messageId: string;
  assistantText: string;
  // Optional small slice of prior turns for context (most-recent-last).
  recentContext?: { role: string; text: string }[];
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildContextBlock(recent: SuggestionRequest['recentContext']): string {
  if (!recent || recent.length === 0) return '';
  const lines = recent.slice(-4).map((entry) => {
    const role = entry.role === 'assistant' ? 'Assistant' : entry.role === 'user' ? 'User' : null;
    if (!role) return null;
    const text = String(entry.text ?? '').trim().slice(0, 600);
    if (!text) return null;
    return `${role}: ${text}`;
  }).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? `\n\nRecent turns:\n${lines.join('\n')}` : '';
}

function parseSuggestions(raw: string): string[] {
  if (!raw) return [];
  // Strip code fences if Gemini ignored the instruction.
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { suggestions?: unknown }).suggestions)) {
      const list = (parsed as { suggestions: unknown[] }).suggestions
        .filter(isString)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 80);
      // Dedupe while preserving order.
      const seen = new Set<string>();
      const deduped = list.filter((s) => {
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return deduped.slice(0, 3);
    }
  } catch {
    return [];
  }
  return [];
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<SuggestionRequest>;
    const messageId = isString(body.messageId) ? body.messageId : null;
    const assistantText = isString(body.assistantText) ? body.assistantText.trim() : '';

    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 });
    }
    if (assistantText.length < 12) {
      return NextResponse.json({ messageId, suggestions: [] });
    }

    if (!GEMINI_API_KEY) {
      // No key — silent empty response (the UI just hides the chip row).
      return NextResponse.json({ messageId, suggestions: [] });
    }

    const truncated = assistantText.length > 4000 ? `${assistantText.slice(0, 4000)}…` : assistantText;
    const contextBlock = buildContextBlock(body.recentContext);
    const userPrompt = `Assistant just said:\n"""\n${truncated}\n"""${contextBlock}\n\nReturn the JSON now.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 200,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      console.log('[suggested-replies] Gemini error', res.status);
      return NextResponse.json({ messageId, suggestions: [] });
    }

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const suggestions = parseSuggestions(typeof raw === 'string' ? raw : '');

    return NextResponse.json({ messageId, suggestions });
  } catch (err) {
    console.log('[suggested-replies] error', err);
    return NextResponse.json(
      { error: sanitizeErrorMessage(err, 'Internal error'), suggestions: [] },
      { status: 200 },
    );
  }
}
