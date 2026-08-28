export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  pollSymonTextTurn,
  readSymonTextPlannerInfo,
} from '@/lib/mobile/symon-text-bridge-client';
import {
  appendSymonTextTranscript,
  createSymonTextSessionFromTranscript,
  formatSymonTextPlannerPrompt,
  loadSymonTextSession,
} from '@/lib/mobile/symon-text-session-store';
import { getManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';

const EXECUTION_EPOCH = randomUUID();
const POLL_WINDOW_MS = 45_000;
const MAX_FIELD_LENGTH = 320;
const MAX_TEXT_LENGTH = 8_000;
const RESTARTED_REPLY = 'The o8 app restarted while I was working on that message, so I stopped instead of risking the same action twice. Please send it again when you are ready.';

interface ManagedMessageBody {
  eventId: string;
  conversationId: string;
  messageId: string;
  sender: string;
  recipient: string;
  text: string;
}

function field(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : '';
}

async function body(request: NextRequest): Promise<ManagedMessageBody | null> {
  const parsed = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!parsed) return null;
  const result = {
    eventId: field(parsed.eventId, MAX_FIELD_LENGTH),
    conversationId: field(parsed.conversationId, MAX_FIELD_LENGTH),
    messageId: field(parsed.messageId, MAX_FIELD_LENGTH),
    sender: field(parsed.sender, MAX_FIELD_LENGTH),
    recipient: field(parsed.recipient, MAX_FIELD_LENGTH),
    text: field(parsed.text, MAX_TEXT_LENGTH),
  };
  return Object.values(result).every(Boolean) ? result : null;
}

function final(text: string) {
  return NextResponse.json({ ok: true, state: 'done', text });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const inbound = await body(request);
  if (!inbound) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const store = getManagedSymonMessagesStore();
  let turn = store.getOrCreateTurn({
    eventId: inbound.eventId,
    conversationId: inbound.conversationId,
    providerMessageId: inbound.messageId,
    senderHandle: inbound.sender,
    recipientHandle: inbound.recipient,
    text: inbound.text,
    now: Date.now(),
  });
  if (turn.status === 'completed' && turn.responseText) return final(turn.responseText);
  if (turn.status === 'failed') {
    return final(turn.responseText || turn.detail || 'I could not complete that request. Please try again.');
  }
  if (
    turn.status === 'processing'
    && turn.executionEpoch
    && turn.executionEpoch !== EXECUTION_EPOCH
  ) {
    store.fail(turn.eventId, RESTARTED_REPLY, Date.now());
    return final(RESTARTED_REPLY);
  }

  if (turn.status === 'queued') {
    const conversation = store.getConversation(turn.conversationId);
    let session = conversation.sessionId
      ? loadSymonTextSession(conversation.sessionId)
      : null;
    if (!session) {
      let info;
      try {
        info = await readSymonTextPlannerInfo();
      } catch (error) {
        return NextResponse.json({
          ok: false,
          state: 'processing',
          error: 'desktop_unavailable',
          detail: error instanceof Error ? error.message : 'Desktop bridge unavailable.',
        }, { status: 503 });
      }
      if (!info.available || !info.engine || !info.model || !info.effort) {
        return NextResponse.json({
          ok: false,
          state: 'processing',
          error: 'no_cli',
          detail: info.detail || 'No supported Symon planner CLI is installed.',
        }, { status: 503 });
      }
      const allowedTools = Array.from(new Set((info.tools ?? []).flatMap((tool) => {
        const name = tool.name;
        return typeof name === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(name) ? [name] : [];
      })));
      session = createSymonTextSessionFromTranscript({
        subject: 'operator',
        deviceId: null,
        engine: info.engine,
        model: info.model,
        effort: info.effort,
        workspaceMode: 'o8',
        repoId: null,
        repoPath: null,
        allowedTools,
      }, conversation.transcript);
    }
    const prompt = formatSymonTextPlannerPrompt(session, turn.requestText);
    turn = store.beginExecution({
      eventId: turn.eventId,
      sessionId: session.sessionId,
      promptText: prompt,
      executionEpoch: EXECUTION_EPOCH,
      now: Date.now(),
    });
    appendSymonTextTranscript(session.sessionId, [{ role: 'user', text: turn.requestText }]);
    store.appendConversation({
      conversationId: turn.conversationId,
      sessionId: session.sessionId,
      entries: [{ role: 'user', text: turn.requestText }],
      now: Date.now(),
    });
  }

  if (!turn.sessionId || !turn.promptText) {
    const message = 'Managed Symon turn state is incomplete. Please send the message again.';
    store.fail(turn.eventId, message, Date.now());
    return final(message);
  }
  const session = loadSymonTextSession(turn.sessionId);
  if (!session) {
    store.fail(turn.eventId, RESTARTED_REPLY, Date.now());
    return final(RESTARTED_REPLY);
  }

  let outcome;
  try {
    outcome = await pollSymonTextTurn({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      prompt: turn.promptText,
      planner: {
        engine: session.engine,
        model: session.model,
        effort: session.effort,
      },
    }, POLL_WINDOW_MS);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'processing',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Desktop bridge unavailable.',
    }, { status: 503 });
  }

  if (outcome.state === 'pending') {
    return NextResponse.json({ ok: true, state: 'processing' }, { status: 202 });
  }
  if (outcome.state === 'needs_confirmation') {
    return NextResponse.json({ ok: true, state: 'awaiting_approval' }, { status: 202 });
  }
  if (
    outcome.state === 'done'
    && outcome.result?.status === 'done'
    && typeof outcome.result.text === 'string'
    && outcome.result.text.trim()
  ) {
    const responseText = outcome.result.text.trim();
    appendSymonTextTranscript(turn.sessionId, [{ role: 'assistant', text: responseText }]);
    store.appendConversation({
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
      entries: [{ role: 'assistant', text: responseText }],
      now: Date.now(),
    });
    store.complete(turn.eventId, responseText, Date.now());
    return final(responseText);
  }

  const detail = outcome.result?.status === 'interrupted'
    ? 'I stopped that request before it completed. Please send it again when you are ready.'
    : outcome.detail || outcome.error || 'I could not complete that request. Please try again.';
  store.fail(turn.eventId, detail, Date.now());
  return final(detail);
}
