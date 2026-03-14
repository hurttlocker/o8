/**
 * POST /api/mobile/enhance
 *
 * Enhances a user prompt using Gemini 2.0 Flash (free tier).
 * Takes raw user text, returns a clearer, more specific version
 * optimized for AI coding agents.
 */
import { NextRequest, NextResponse } from 'next/server';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `You are a prompt engineer for AI coding agents. Your job is to enhance user prompts to be clearer, more specific, and more effective.

Rules:
- Keep the same intent — never change what the user is asking for
- Add specificity: mention likely files, patterns, or approaches when obvious
- Add quality expectations: tests, error handling, edge cases
- Stay concise — enhanced prompt should be 2-4 sentences max
- Never add pleasantries, greetings, or filler
- Never wrap in quotes or add labels like "Enhanced:"
- Return ONLY the enhanced prompt text, nothing else
- If the prompt is already excellent, return it unchanged
- Match the user's tone — if casual, stay casual but clearer`;

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return NextResponse.json({ error: 'Prompt too short' }, { status: 400 });
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
    }

    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 300,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[enhance] Gemini error:', res.status, errText);
      return NextResponse.json({ error: 'Enhancement failed' }, { status: 502 });
    }

    const data = await res.json();
    const enhanced = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!enhanced) {
      return NextResponse.json({ error: 'Empty response from model' }, { status: 502 });
    }

    return NextResponse.json({ enhanced, model: GEMINI_MODEL });
  } catch (err) {
    console.error('[enhance] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
