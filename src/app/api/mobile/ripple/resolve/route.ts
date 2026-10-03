import { NextRequest, NextResponse } from 'next/server';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { parseRippleResolutionDraft } from '@/lib/mobile/ripple-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RIPPLE_MODEL = 'openai/gpt-oss-120b:free';
const MAX_UTTERANCE = 4_000;

function noResolution() {
  return NextResponse.json({ kind: 'none' as const });
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function prompt(utterance: string, repoName?: string) {
  return [
    {
      role: 'system',
      content: [
        'You are Ripple, an intent error-correction layer between voice input and an AODL task contract.',
        'Find at most ONE ambiguity whose resolution could materially change the executed or verified outcome.',
        'Do not ask about details the agent can safely infer or discover while working.',
        'If no consequential ambiguity exists, return {"kind":"none"}.',
        'Otherwise return JSON only:',
        '{"kind":"choice","question":"short question","options":[{"label":"short","value":"canonical-value"}],"aodlPath":"dotted.path","confidence":0.0}',
        'Provide 2-4 mutually useful options. Keep the question under 12 words.',
        'aodlPath must identify the intent field being resolved, e.g. intent.target, constraints.latency, constraints.behavior, references.primary, verification.success.',
        'Never add permissions, authority, credentials, destructive actions, or scope the user did not state.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        utterance,
        ...(repoName ? { repo: repoName } : {}),
      }),
    },
  ];
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { utterance?: unknown; repoName?: unknown } | null;
  const utterance = typeof body?.utterance === 'string' ? body.utterance.trim() : '';
  const repoName = typeof body?.repoName === 'string' ? body.repoName.trim().slice(0, 120) : undefined;

  if (!utterance || utterance.length > MAX_UTTERANCE) {
    return NextResponse.json({ error: 'Expected a non-empty utterance up to 4000 characters.' }, { status: 400 });
  }
  if (utterance.length < 8) return noResolution();

  try {
    const route = await resolveOpenRouterRoute({ provisionInstallAllowance: true });
    if (!route) return noResolution();

    const response = await fetch(route.url, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify({
        model: route.model || RIPPLE_MODEL,
        messages: prompt(utterance, repoName),
        temperature: 0,
        max_tokens: 320,
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return noResolution();

    const payload = await response.json().catch(() => null) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return noResolution();

    const draft = parseRippleResolutionDraft(extractJsonObject(content));
    if (!draft || draft.kind === 'none') return noResolution();

    return NextResponse.json({
      ...draft,
      id: crypto.randomUUID(),
    });
  } catch {
    // Ripple is an optimization layer; inference failure must never block voice.
    return noResolution();
  }
}
