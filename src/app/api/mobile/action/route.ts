import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { rejectLlmApproval, resumeLlmApproval } from '@/lib/approvals/llm';
import { getApproval, listApprovals, resolveApproval } from '@/lib/approvals/store';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { launchCodexFromMobile, performRuntimeAction } from '@/lib/runtime/actions';
import { readPersistedLlmChat, writePersistedLlmChat, type PersistedLlmChatHistory, type PersistedLlmChatMessage } from '@/lib/llm/chat-history-store';
import { steerOpenClawSession } from '@/lib/openclaw/chat';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function previewMessage(message?: string) {
  if (!message) return '';
  return message.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function invalidateMutationCaches() {
  invalidateCommandCenterSnapshotCaches();
  invalidateInboxCache();
}

function providerForLlmModel(model?: string): 'openai' | 'anthropic' | 'google' {
  if (!model) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  return 'openai';
}

function buildLlmImagesMarkdown(attachments: MobileActionRequest['attachments']) {
  const images = (attachments ?? []).filter((item) => item?.mimeType?.startsWith('image/') && item?.content);
  if (!images.length) return '';
  return images.map((item, index) => `![Image ${index + 1}](${item.content})`).join('\n');
}

function cleanProxyContent(text: string) {
  return text
    .replace(/^I'll use the \w+ tool[^\n]*\n*/gm, '')
    .replace(/^I'll use the \w+ tool[^\n]*/gm, '')
    .replace(/^Let me use[^\n]*tool[^\n]*\n*/gm, '')
    .trim();
}

function buildLlmRequestMessages(history: PersistedLlmChatHistory, nextUserContent: string) {
  const cleanMessages = (history.messages ?? [])
    .filter((message) => {
      if (message.isError || message.isPartial) return false;
      if (!message.content?.trim()) return false;
      if (message.content.startsWith('Error: ')) return false;
      if (message.content.startsWith('Action cancelled:')) return false;
      return true;
    })
    .map((message) => ({ role: message.role, content: message.content }));

  const recentMessages = cleanMessages.length > 40
    ? cleanMessages.slice(-40)
    : cleanMessages;

  return [
    ...recentMessages,
    { role: 'user', content: nextUserContent },
  ];
}

async function runLlmChatTurn(request: NextRequest, payload: MobileActionRequest, clientMutationId: string) {
  const sessionKey = payload.sessionKey.trim();
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  const existing = readPersistedLlmChat(tabId)?.history ?? { messages: [] } satisfies PersistedLlmChatHistory;
  const message = payload.message?.trim();
  const imageMarkdown = buildLlmImagesMarkdown(payload.attachments);
  const userContent = [message, imageMarkdown].filter(Boolean).join('\n\n').trim();

  if (!userContent) {
    return NextResponse.json(
      { error: 'message or image attachment is required for llm-chat' },
      { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  const model = existing.model || 'gpt-5.4';
  const provider = providerForLlmModel(model);
  const userMessage: PersistedLlmChatMessage = {
    id: `user-${Date.now()}`,
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  };

  let responseText = '';
  let tokens: { input: number; output: number } | undefined;
  let costUsd: number | undefined;
  let thinkingText = '';
  let toolCalls: MobileTranscriptToolCall[] = [];
  let sources: MobileTranscriptSource[] = [];
  let errorText: string | null = null;
  let approvalRequired: { id?: string; summary?: string } | null = null;

  const res = await fetch(new URL('/api/v2/proxy/llm', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tab-id': tabId,
    },
    body: JSON.stringify({
      model,
      provider,
      messages: buildLlmRequestMessages(existing, userContent),
      approvedTools: [],
    }),
    cache: 'no-store',
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const note = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(note);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n');
    buffer = chunks.pop() ?? '';
    for (const line of chunks) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === 'content' && typeof parsed.text === 'string') {
        responseText += parsed.text;
      } else if (parsed.type === 'usage') {
        tokens = {
          input: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0,
          output: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0,
        };
        costUsd = typeof parsed.costUsd === 'number' ? parsed.costUsd : undefined;
      } else if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
        thinkingText += parsed.text;
      } else if (parsed.type === 'tool_call' && typeof parsed.name === 'string') {
        toolCalls = [...toolCalls, {
          name: parsed.name,
          args: parsed.args && typeof parsed.args === 'object' ? parsed.args as Record<string, unknown> : undefined,
          status: 'done',
        }];
      } else if (parsed.type === 'sources' && Array.isArray(parsed.sources)) {
        sources = parsed.sources as MobileTranscriptSource[];
      } else if (parsed.type === 'approval_required') {
        approvalRequired = {
          id: typeof parsed.id === 'string' ? parsed.id : undefined,
          summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        };
      } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
        errorText = parsed.message;
      }
    }
  }

  const persistedMessages = [...(existing.messages ?? []), userMessage];

  if (approvalRequired) {
    const note = approvalRequired.summary || 'Approval required for this workspace chat tool call.';
    writePersistedLlmChat(tabId, {
      ...existing,
      model,
      messages: [
        ...persistedMessages,
        {
          id: `approval-pending-${Date.now()}`,
          role: 'assistant',
          content: `Approval pending: ${note}`,
          timestamp: Date.now(),
          model,
        },
      ],
    });
    invalidateMutationCaches();
    await publishMobileMutation(clientMutationId, {
      action: payload.action,
      sessionKey,
      runtime: 'chat',
      status: 'queued',
      note,
    });
    return NextResponse.json({
      ok: true,
      action: payload.action,
      sessionKey,
      clientMutationId,
      status: 'queued',
      note,
      approvalId: approvalRequired.id,
    }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (errorText) {
    writePersistedLlmChat(tabId, {
      ...existing,
      model,
      messages: [
        ...persistedMessages,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${errorText}`,
          timestamp: Date.now(),
          isError: true,
          model,
        },
      ],
    });
    throw new Error(errorText);
  }

  const assistantMessage: PersistedLlmChatMessage = {
    id: `asst-${Date.now()}`,
    role: 'assistant',
    content: cleanProxyContent(responseText),
    model,
    tokens,
    costUsd,
    timestamp: Date.now(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    sources: sources.length > 0 ? sources : undefined,
    thinking: thinkingText || undefined,
  };

  writePersistedLlmChat(tabId, {
    ...existing,
    model,
    messages: [...persistedMessages, assistantMessage],
  });
  invalidateMutationCaches();
  await publishMobileMutation(clientMutationId, {
    action: payload.action,
    sessionKey,
    runtime: 'chat',
    status: 'completed',
    note: 'Workspace chat responded.',
  });

  const response: MobileActionResponse = {
    ok: true,
    action: payload.action,
    sessionKey,
    clientMutationId,
    status: 'completed',
    note: 'Workspace chat responded.',
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

async function publishMobileMutation(
  mutationId: string,
  payload: {
    action: string;
    sessionKey?: string;
    runtime?: string;
    status: 'pending' | 'queued' | 'completed' | 'failed';
    note: string;
  },
) {
  await publishRealtimeMutation({
    mutation: {
      mutationId,
      source: 'mobile',
      action: payload.action,
      runtime: payload.runtime,
      surfaceId: payload.sessionKey,
      sessionKey: payload.sessionKey,
      status: payload.status,
      note: payload.note,
      createdAt: new Date().toISOString(),
      settledAt: payload.status === 'pending' ? undefined : new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox', ...(payload.sessionKey ? ['sessionHistory' as const] : [])],
    sessionKeys: payload.sessionKey ? [payload.sessionKey] : [],
    fresh: payload.status !== 'failed',
  });
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as MobileActionRequest | null;
  const action = payload?.action;
  const sessionKey = payload?.sessionKey?.trim();

  if (!action || !sessionKey) {
    return NextResponse.json({ error: 'action and sessionKey are required' }, { status: 400 });
  }

  const clientMutationId = payload?.clientMutationId?.trim() || `mutation-${Date.now()}`;

  try {
    const isOwnedCodex = sessionKey.startsWith('codex-owned:');
    console.info('[mobile/action] request', {
      action,
      sessionKey,
      clientMutationId,
      cwd: payload?.cwd,
      hasMessage: Boolean(payload?.message?.trim()),
      attachmentCount: payload?.attachments?.length ?? 0,
      messagePreview: previewMessage(payload?.message),
    });

    if (sessionKey.startsWith('llm-chat:') && (action === 'steer' || action === 'send')) {
      return await runLlmChatTurn(request, payload, clientMutationId);
    }

    // ── Send message to an OpenClaw agent session ──
    if (action === 'send') {
      const message = (payload as unknown as Record<string, unknown>)?.message as string | undefined;
      if (!message?.trim()) {
        return NextResponse.json(
          { error: 'message is required for send' },
          { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      try {
        const result = await steerOpenClawSession(sessionKey, message.trim());
        const response: MobileActionResponse = {
          ok: true,
          action: 'send',
          sessionKey,
          clientMutationId,
          status: 'sent',
          note: `Message sent to ${sessionKey}`,
          runId: (result as Record<string, unknown>)?.runId as string | undefined,
        };
        invalidateMutationCaches();
        await publishMobileMutation(clientMutationId, {
          action: 'send',
          sessionKey,
          runtime: 'openclaw',
          status: 'queued',
          note: response.note,
        });
        console.info('[mobile/action] send queued', { sessionKey, clientMutationId, runId: response.runId ?? null });
        return NextResponse.json(response, {
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      } catch (err) {
        const note = err instanceof Error ? err.message : 'Send failed';
        await publishMobileMutation(clientMutationId, {
          action: 'send',
          sessionKey,
          runtime: 'openclaw',
          status: 'failed',
          note,
        });
        console.warn('[mobile/action] send failed', { sessionKey, clientMutationId, note });
        return NextResponse.json(
          { ok: false, action: 'send', sessionKey, clientMutationId, status: 'error', note },
          { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
    }

    if (action === 'launch') {
      const cwd = payload?.cwd?.trim();
      const message = payload?.message?.trim();
      if (!cwd || !message) {
        return NextResponse.json(
          { error: 'cwd and message are required for launch' },
          { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      const result = await launchCodexFromMobile(cwd, message);
      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey: result.surfaceId ?? sessionKey,
        clientMutationId,
        status: result.status,
        note: result.note,
      };
      if (result.ok) {
        invalidateMutationCaches();
      }
      console.info('[mobile/action] launch result', {
        requestedSessionKey: sessionKey,
        resolvedSessionKey: response.sessionKey,
        clientMutationId,
        ok: result.ok,
        status: result.status,
      });
      await publishMobileMutation(clientMutationId, {
        action,
        sessionKey: response.sessionKey,
        runtime: 'codex',
        status: result.ok ? 'queued' : 'failed',
        note: result.note,
      });
      return NextResponse.json(response, {
        status: 200,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (action === 'approve' || action === 'deny') {
      const explicitApprovalId = payload?.approvalId?.trim();
      const pendingForSession = explicitApprovalId
        ? []
        : listApprovals({ status: 'pending', sessionKey });
      const approvalId = explicitApprovalId || (pendingForSession.length === 1 ? pendingForSession[0]?.id : '');
      if (!approvalId) {
        return NextResponse.json(
          { ok: false, action, sessionKey, clientMutationId, status: 'unavailable', note: 'No pending approval found for this mobile session.' },
          { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      const currentApproval = getApproval(approvalId);
      if (!currentApproval) {
        return NextResponse.json(
          { ok: false, action, sessionKey, clientMutationId, status: 'unavailable', note: 'Approval not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      if (currentApproval.status !== 'pending') {
        return NextResponse.json(
          { ok: true, action, sessionKey, clientMutationId, status: 'completed', note: 'Approval was already resolved.' },
          { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      const approval = resolveApproval(approvalId, action === 'approve' ? 'approve' : 'reject', 'mobile');
      if (!approval) {
        return NextResponse.json(
          { ok: false, action, sessionKey, clientMutationId, status: 'unavailable', note: 'Approval not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      // Route approval resolution based on continuation type
      let decisionNote = action === 'approve' ? 'Approved.' : 'Denied.';
      const continuation = approval.continuation;

      if (continuation?.kind === 'llm-chat') {
        // LLM chat continuation — resume or reject the chat turn
        const decision = action === 'approve'
          ? await resumeLlmApproval(request.url, approval, { actor: 'mobile' })
          : rejectLlmApproval(approval, 'mobile');
        decisionNote = decision.note;
      } else if (continuation?.kind === 'lane' && action === 'approve') {
        // Lane continuation — re-dispatch the lane command
        try {
          const { dispatch } = await import('@/lib/lane/commands');
          const result = await dispatch({
            verb: continuation.verb,
            laneId: continuation.laneId,
            commitMessage: continuation.commitMessage,
            actor: 'user', // approved by human, bypass policy re-check
          } as Parameters<typeof dispatch>[0]);
          decisionNote = result.note;
        } catch (err) {
          decisionNote = `Lane ${continuation.verb} failed: ${err instanceof Error ? err.message : 'unknown'}`;
        }
      } else if (continuation?.kind === 'runtime' && action === 'approve') {
        // Runtime continuation — launch or resume the session
        try {
          if (continuation.action === 'launch' && continuation.prompt) {
            const rt = getRuntime(continuation.runtimeId);
            if (rt) {
              const result = await rt.launch({
                cwd: continuation.cwd || process.cwd(),
                prompt: continuation.prompt,
              });
              decisionNote = result.note;
            }
          } else if (continuation.action === 'resume' && continuation.message) {
            const rt = getRuntime(continuation.runtimeId);
            if (rt) {
              const result = await rt.resume(continuation.sessionKey, continuation.message);
              decisionNote = result.note;
            }
          }
        } catch (err) {
          decisionNote = `Runtime action failed: ${err instanceof Error ? err.message : 'unknown'}`;
        }
      }

      invalidateMutationCaches();
      await publishMobileMutation(clientMutationId, {
        action,
        sessionKey: approval.sessionKey,
        runtime: approval.runtime,
        status: 'completed',
        note: decisionNote,
      });

      return NextResponse.json({
        ok: true,
        action,
        sessionKey: approval.sessionKey,
        clientMutationId,
        status: 'completed',
        note: decisionNote,
      }, {
        status: 200,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (action === 'resume') {
      const message = (payload as unknown as Record<string, unknown>)?.message as string | undefined;

      // Route 1: IDE-owned Codex — use existing performRuntimeAction path
      if (isOwnedCodex) {
        const result = await performRuntimeAction({
          action: 'send_input',
          surfaceId: sessionKey,
          clientMutationId,
          message,
          runId: payload?.runId,
        });

        const response: MobileActionResponse = {
          ok: result.ok,
          action,
          sessionKey,
          clientMutationId,
          status: result.status,
          note: result.note,
          runId: result.runId,
          aborted: result.aborted,
        };
        if (result.ok) {
          invalidateMutationCaches();
        }
        console.info('[mobile/action] owned resume result', {
          sessionKey,
          clientMutationId,
          ok: result.ok,
          status: result.status,
          runId: result.runId ?? null,
        });
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          runtime: 'codex',
          status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
          note: result.note,
        });

        return NextResponse.json(response, {
          status: result.status === 'unavailable' ? 501 : 200,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }

      // Route 2: Claude Code sessions — use claude-code runtime adapter
      if (sessionKey.startsWith('claude-code:')) {
        const ccRuntime = getRuntime('claude-code');
        if (!ccRuntime?.resume) {
          return NextResponse.json(
            { ok: false, action, sessionKey, status: 'unavailable', note: 'Claude Code runtime not available.' },
            { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
          );
        }
        const result = await ccRuntime.resume(sessionKey, message ?? '');
        if (result.ok) {
          invalidateMutationCaches();
        }
        console.info('[mobile/action] claude-code resume result', {
          sessionKey,
          clientMutationId,
          ok: result.ok,
          note: result.note,
        });
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          runtime: 'claude-code',
          status: result.ok ? 'queued' : 'failed',
          note: result.note,
        });
        return NextResponse.json(
          { ok: result.ok, action, sessionKey, clientMutationId, status: result.ok ? 'sent' : 'error', note: result.note },
          { status: result.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      // Route 3: Discovered Codex sessions — send directly to Codex CLI
      // NOT through OpenClaw gateway (discovered sessions aren't gateway sessions)
      if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
        const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
        try {
          const { execFileSync } = await import('node:child_process');
          const os = await import('node:os');
          const path = await import('node:path');
          const codexBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
          
          // Use codex exec resume <threadId> <message> — same as desktop /api/codex/send
          const args = ['exec', 'resume', threadId, message ?? '', '--json', '--dangerously-bypass-approvals-and-sandbox'];
          const stdout = execFileSync(codexBin, args, {
            cwd: process.env.HOME || os.homedir(),
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            encoding: 'utf-8',
          });

          // Parse last turn.completed for usage
          const lines = stdout.split('\n').filter(Boolean);
          let responseText = '';
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === 'item.completed') {
                const item = event.item as { type?: string; text?: string } | undefined;
                if (item?.type === 'agent_message' && item.text) {
                  responseText += item.text;
                }
              }
            } catch { /* skip non-JSON */ }
          }

          invalidateMutationCaches();
          console.info('[mobile/action] discovered codex CLI resume', {
            sessionKey,
            threadId,
            responseLength: responseText.length,
          });

          await publishMobileMutation(clientMutationId, {
            action,
            sessionKey,
            runtime: 'codex',
            status: 'completed',
            note: responseText ? 'Codex responded.' : 'Sent to Codex.',
          });

          return NextResponse.json(
            { ok: true, action, sessionKey, clientMutationId, status: 'completed', note: 'Sent to Codex.' },
            { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } },
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error';
          console.error('[mobile/action] discovered codex CLI resume failed:', errMsg);
          await publishMobileMutation(clientMutationId, {
            action,
            sessionKey,
            runtime: 'codex',
            status: 'failed',
            note: `Codex CLI error: ${errMsg}`,
          });
          return NextResponse.json(
            { ok: false, action, sessionKey, clientMutationId, status: 'error', note: errMsg },
            { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
          );
        }
      }

      // Route 4: Unknown session type
      return NextResponse.json(
        { ok: false, action, sessionKey, status: 'unavailable', note: `Don't know how to resume session: ${sessionKey.split(':')[0]}` },
        { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    if (action === 'watch' || action === 'resolve') {
      if (!isOwnedCodex) {
        const response: MobileActionResponse = {
          ok: false,
          action,
          sessionKey,
          status: 'unavailable',
          note: `${action} is only wired truthfully for IDE-owned Codex review packets on mobile right now.`,
        };
        return NextResponse.json(response, {
          status: 501,
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }

      const result = await performRuntimeAction({
        action,
        surfaceId: sessionKey,
        clientMutationId,
      });

      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey,
        clientMutationId,
        status: result.status,
        note: result.note,
      };
      if (result.ok) {
        invalidateMutationCaches();
      }
      await publishMobileMutation(clientMutationId, {
        action,
        sessionKey,
        runtime: 'codex',
        status: result.ok ? 'completed' : 'failed',
        note: result.note,
      });

      return NextResponse.json(response, {
        status: result.status === 'unavailable' ? 501 : 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    if (action !== 'steer' && action !== 'stop') {
      const response: MobileActionResponse = {
        ok: false,
        action,
        sessionKey,
        status: 'unavailable',
        note: `${action} is part of the mobile control contract, but it is not wired truthfully on the current runtime lane yet.`,
      };
      return NextResponse.json(response, {
        status: 501,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    const result = await performRuntimeAction({
      action,
      surfaceId: sessionKey,
      clientMutationId,
      message: payload?.message,
      attachments: payload?.attachments,
      runId: payload?.runId,
    });

    const response: MobileActionResponse = {
      ok: result.ok,
      action,
      sessionKey,
      clientMutationId,
      status: result.status,
      note: result.note,
      runId: result.runId,
      aborted: result.aborted,
    };
    if (result.ok) {
      invalidateMutationCaches();
    }
    console.info('[mobile/action] runtime action result', {
      action,
      sessionKey,
      clientMutationId,
      ok: result.ok,
      status: result.status,
      runId: result.runId ?? null,
    });
    await publishMobileMutation(clientMutationId, {
      action,
      sessionKey,
      runtime: sessionKey.startsWith('codex') ? 'codex' : 'openclaw',
      status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
      note: result.note,
    });

    return NextResponse.json(response, {
      status: result.status === 'unavailable' ? 501 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[mobile/action] request failed', {
      action,
      sessionKey,
      clientMutationId,
      error: error instanceof Error ? error.message : String(error),
    });
    await publishMobileMutation(clientMutationId, {
      action,
      sessionKey,
      status: 'failed',
      note: error instanceof Error ? error.message : 'Unable to perform mobile action',
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform mobile action',
      },
      { status: 500 },
    );
  }
}
