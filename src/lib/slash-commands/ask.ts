'use client';

/**
 * /ask <question> — Ask the Brain from the chat composer.
 *
 * Streams from /api/cortex/ask, collects tokens + citations, then appends
 * two entries to the transcript: a user bubble with the question, and a
 * command entry with the Brain answer and citation pills.
 */

import type { BrainAnswerCitation } from '@/lib/mobile/types';
import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

interface SseFrame {
  name: string;
  data: unknown;
}

function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const segments = buffer.split('\n\n');
  const rest = segments.pop() ?? '';
  for (const segment of segments) {
    const lines = segment.split('\n');
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        name = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    frames.push({ name, data });
  }
  return { frames, rest };
}

function coerceCitation(payload: unknown): BrainAnswerCitation | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || typeof obj.rowId !== 'string' || !obj.rowId) return null;
  return {
    kind: obj.kind,
    rowId: obj.rowId,
    excerpt: typeof obj.excerpt === 'string' ? obj.excerpt : '',
    url: typeof obj.url === 'string' ? obj.url : null,
  };
}

async function streamBrainAnswer(
  question: string,
  repoPath: string | null,
): Promise<{ tokens: string; citations: BrainAnswerCitation[]; error?: string }> {
  let tokens = '';
  const citations: BrainAnswerCitation[] = [];

  try {
    const res = await fetch('/api/cortex/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, repoPath }),
    });

    if (!res.ok || !res.body) {
      return { tokens: '', citations: [], error: `HTTP ${res.status}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.name === 'token') {
          const text =
            typeof frame.data === 'object' && frame.data !== null
              ? String((frame.data as Record<string, unknown>).text ?? '')
              : '';
          if (text) tokens += text;
        } else if (frame.name === 'citation') {
          const c = coerceCitation(frame.data);
          if (c) citations.push(c);
        } else if (frame.name === 'error') {
          const message =
            typeof frame.data === 'object' && frame.data !== null
              ? String((frame.data as Record<string, unknown>).message ?? 'stream error')
              : 'stream error';
          return { tokens, citations, error: message };
        }
      }
    }
  } catch (err) {
    return { tokens, citations, error: err instanceof Error ? err.message : 'request failed' };
  }

  return { tokens, citations };
}

export async function handleAskSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const question = command.args.trim();
  if (!question) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'ask',
        summary: 'Ask needs a question — e.g. /ask what is the typecheck command?',
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  // Optimistic user bubble — shows the question immediately.
  const ts = Date.now();
  context.appendEntries([
    {
      id: `ask-q-${ts}`,
      role: 'user',
      text: question,
      timestamp: ts,
      timestampLabel: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const { tokens, citations, error } = await streamBrainAnswer(question, context.repoPath);

  if (error && !tokens) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'ask',
        summary: `Brain unavailable: ${error}`,
        chips: [{ label: 'error', tone: 'red' }],
      }),
    ]);
    return { handled: true };
  }

  const answerTs = Date.now();
  context.appendEntries([
    {
      id: `ask-a-${answerTs}`,
      role: 'system',
      type: 'command',
      text: tokens || '(no answer)',
      timestamp: answerTs,
      timestampLabel: new Date(answerTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      command: {
        name: 'ask',
        summary: tokens || '(no answer)',
        chips: citations.length > 0
          ? [{ label: `${citations.length} source${citations.length === 1 ? '' : 's'}`, tone: 'blue' }]
          : [],
        brainAnswer: { tokens, citations },
      },
    },
  ]);

  return { handled: true };
}
