import { NextResponse } from 'next/server';
import { getContextInjection } from '@/lib/cortex/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const prompt = body.prompt?.trim();
    const cwd = body.cwd;
    const branch = body.branch;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const injection = await getContextInjection(prompt, cwd, branch);
    return NextResponse.json(injection);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Context injection failed' },
      { status: 500 },
    );
  }
}
