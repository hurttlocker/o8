import { NextRequest, NextResponse } from 'next/server';
import { buildErrorPayload, sanitizeErrorMessage } from '@/lib/api/error-format';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { rejectLlmApproval, resumeLlmApproval } from '@/lib/approvals/llm';
import { claimApprovalResolution } from '@/lib/approvals/resolution';
import { getApproval, listApprovals } from '@/lib/approvals/store';
import {
  buildLlmRequestMessages,
  cleanProxyContent,
  defaultMobileLlmModel,
  ensurePersistedMobileLlmChatSession,
  providerForLlmModel,
} from '@/lib/llm/mobile-chat-session';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { selectMobileReviewApprovalId } from '@/lib/mobile/action-approval';
import {
  mobileActionInProgressPayload,
  resolveMobileActionIdempotencyIdentity,
  restoreMobileActionResponse,
  serializeMobileActionResponse,
  type SerializedMobileActionResponse,
} from '@/lib/mobile/action-idempotency';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { launchCodexFromMobile, launchRuntimeSurface, performRuntimeAction } from '@/lib/runtime/actions';
import { writePersistedLlmChat, type PersistedLlmChatHistory, type PersistedLlmChatMessage } from '@/lib/llm/chat-history-store';
import type { RuntimeId } from '@/lib/runtimes';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';
import { getOrCreateWsToken } from '@/lib/ws-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };
const MOBILE_ACTION_IDEMPOTENCY_VERB = 'mobile-action';
const MOBILE_ACTION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
function previewMessage(message?: string) {
  if (!message) return '';
  return message.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function invalidateMutationCaches() {
  invalidateCommandCenterSnapshotCaches();
  invalidateInboxCache();
}

function buildLlmImagesMarkdown(attachments: MobileActionRequest['attachments']) {
  const images = (attachments ?? []).filter((item) => item?.mimeType?.startsWith('image/') && item?.content);
  if (!images.length) return '';
  return images.map((item, index) => `![Image ${index + 1}](${item.content})`).join('\n');
}

function actionErrorResponse(error: string, status: number, detail?: unknown) {
  return NextResponse.json(buildErrorPayload(error, detail), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Structured, machine-readable error for approval-addressing failures — carries
 * an explicit `ok:false` + a stable `error` code (and optional extra fields like
 * `approvalIds`) so a newer mobile client can react programmatically instead of
 * parsing a free-text message.
 */
function actionStructuredError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

async function runLlmChatTurn(request: NextRequest, payload: MobileActionRequest, clientMutationId: string) {
  const sessionKey = payload.sessionKey.trim();
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  const existing = ensurePersistedMobileLlmChatSession(tabId) ?? { messages: [] } satisfies PersistedLlmChatHistory;
  const message = payload.message?.trim();
  const imageMarkdown = buildLlmImagesMarkdown(payload.attachments);
  const userContent = [message, imageMarkdown].filter(Boolean).join('\n\n').trim();

  if (!userContent) {
    return actionErrorResponse('message or image attachment is required for llm-chat', 400);
  }

  const model = existing.model || defaultMobileLlmModel();
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
      Authorization: `Bearer ${getOrCreateWsToken()}`,
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
    // Bubble proxy failures to the top-level POST catch so the route returns one structured error shape.
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
      headers: NO_STORE_HEADERS,
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
    // Bubble model/tool failures to the top-level POST catch so mobile clients get a structured error body.
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
    headers: NO_STORE_HEADERS,
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

async function handleMobileActionPost(request: NextRequest) {
  let action: MobileActionRequest['action'] | undefined;
  let sessionKey: string | undefined;
  let clientMutationId = `mutation-${Date.now()}`;

  try {
    const payload = (await request.json().catch(() => null)) as MobileActionRequest | null;
    if (!payload) {
      return actionErrorResponse('Invalid JSON body', 400);
    }

    action = payload.action;
    sessionKey = payload.sessionKey?.trim();
    if (!action || !sessionKey) {
      return actionErrorResponse('action and sessionKey are required', 400);
    }

    clientMutationId = payload.clientMutationId?.trim() || clientMutationId;
    const isOwnedCodex = sessionKey.startsWith('codex-owned:');

    console.info('[mobile/action] request', {
      action,
      sessionKey,
      clientMutationId,
      cwd: payload.cwd,
      hasMessage: Boolean(payload.message?.trim()),
      attachmentCount: payload.attachments?.length ?? 0,
      messagePreview: previewMessage(payload.message),
    });

    if (sessionKey.startsWith('llm-chat:') && (action === 'steer' || action === 'send')) {
      return await runLlmChatTurn(request, payload, clientMutationId);
    }

    if (action === 'send') {
      return actionErrorResponse('send is no longer supported on mobile runtime sessions. Use steer instead.', 400);
    }

    if (action === 'launch') {
      const cwd = payload.cwd?.trim();
      const message = payload.message?.trim();
      if (!cwd || !message) {
        return actionErrorResponse('cwd and message are required for launch', 400);
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
        headers: NO_STORE_HEADERS,
      });
    }

    if (action === 'approve' || action === 'request_changes' || action === 'deny') {
      const explicitApprovalId = payload.approvalId?.trim();
      let currentApproval: ReturnType<typeof getApproval> = null;

      if (explicitApprovalId) {
        // approvalId is AUTHORITATIVE. Resolve it directly and NEVER fall back to
        // the sessionKey lookup — a stale/recycled/renamed sessionKey sent
        // alongside a valid approvalId must not re-target a different pending
        // card (the mis-targeted-merge hazard). A missing or already-resolved
        // card fails structured; it does not silently address something else.
        currentApproval = getApproval(explicitApprovalId);
        if (!currentApproval) {
          return actionStructuredError('approval_not_found', 409);
        }
        if (currentApproval.sessionKey !== sessionKey) {
          console.warn('[mobile/action] approvalId is authoritative; ignoring mismatched sessionKey for addressing', {
            approvalId: explicitApprovalId,
            requestSessionKey: sessionKey,
            approvalSessionKey: currentApproval.sessionKey,
            clientMutationId,
          });
        }
        if (currentApproval.status !== 'pending') {
          return actionStructuredError('approval_resolved', 410);
        }
      } else {
        // Legacy clients (no approvalId): resolve by session — kept exactly as
        // before for back-compat — but refuse to GUESS when the session has more
        // than one pending card. Returning the ids lets a newer client re-issue
        // the request addressed to the specific approval it means.
        const pendingForSession = listApprovals({ status: 'pending', sessionKey });
        if (pendingForSession.length > 1) {
          return actionStructuredError('ambiguous_approval', 409, {
            approvalIds: pendingForSession.map((approval) => approval.id),
          });
        }
        const approvalId = selectMobileReviewApprovalId(undefined, pendingForSession);
        if (!approvalId) {
          return actionErrorResponse('No pending approval found for this mobile session.', 404);
        }
        currentApproval = getApproval(approvalId);
        if (!currentApproval) {
          return actionErrorResponse('Approval not found.', 404);
        }
        if (currentApproval.status !== 'pending') {
          return NextResponse.json(
            { ok: true, action, sessionKey, clientMutationId, status: 'completed', note: 'Approval was already resolved.' },
            { status: 200, headers: NO_STORE_HEADERS },
          );
        }
      }

      const approvalId = currentApproval.id;
      const resolutionClaim = claimApprovalResolution(
        approvalId,
        action === 'approve' ? 'approve' : 'reject',
        'mobile', payload.message?.trim(),
        currentApproval.updatedAt,
      );
      const approval = resolutionClaim.approval;
      if (!approval) return actionErrorResponse('Approval not found.', 404);
      if (!resolutionClaim.claimed) return actionStructuredError('approval_resolved', 410);

      let decisionNote = action === 'approve' ? 'Approved.' : action === 'request_changes' ? 'Changes requested.' : 'Denied.';
      const continuation = approval.continuation;

      if (continuation?.kind === 'llm-chat') {
        const decision = action === 'approve'
          ? await resumeLlmApproval(request.url, approval, { actor: 'mobile' })
          : rejectLlmApproval(approval, 'mobile');
        decisionNote = decision.note;
      } else if (continuation?.kind === 'lane' && action === 'approve') {
        try {
          const { dispatch } = await import('@/lib/lane/commands');
          const result = await dispatch({
            verb: continuation.verb,
            laneId: continuation.laneId,
            commitMessage: continuation.commitMessage,
            expectedHeadSha: continuation.expectedHeadSha,
            actor: 'user',
          } as Parameters<typeof dispatch>[0]);
          decisionNote = result.note;
        } catch (error) {
          decisionNote = `Lane ${continuation.verb} failed: ${sanitizeErrorMessage(error, 'unknown')}`;
        }
      } else if (continuation?.kind === 'plan' && action === 'approve') {
        try {
          const { dispatchApprovedPlan } = await import('@/lib/intake/plan-dispatch');
          const result = await dispatchApprovedPlan(continuation);
          decisionNote = result.note;
        } catch (error) {
          decisionNote = `Plan dispatch failed: ${sanitizeErrorMessage(error, 'unknown')}`;
        }
      } else if (continuation?.kind === 'runtime' && action === 'approve') {
        try {
          if (continuation.action === 'launch' && continuation.prompt) {
            const cwd = continuation.cwd || process.cwd();
            const result = await launchRuntimeSurface({
              runtime: continuation.runtimeId as RuntimeId,
              cwd,
              repoPath: cwd,
              prompt: continuation.prompt,
              skipSetup: true,
            });
            decisionNote = result.note;
          } else if (continuation.action === 'resume' && continuation.message) {
            const rt = getRuntime(continuation.runtimeId);
            if (rt) {
              const result = await rt.resume(continuation.sessionKey, continuation.message);
              decisionNote = result.note;
            }
          }
        } catch (error) {
          decisionNote = `Runtime action failed: ${sanitizeErrorMessage(error, 'unknown')}`;
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
        headers: NO_STORE_HEADERS,
      });
    }

    if (action === 'resume') {
      const message = (payload as unknown as Record<string, unknown>).message as string | undefined;

      if (isOwnedCodex) {
        const result = await performRuntimeAction({
          action: 'send_input',
          surfaceId: sessionKey,
          clientMutationId,
          message,
          runId: payload.runId,
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

        if (result.status === 'unavailable') {
          return actionErrorResponse(result.note, 501);
        }

        return NextResponse.json(response, {
          status: 200,
          headers: NO_STORE_HEADERS,
        });
      }

      if (sessionKey.startsWith('claude-code:')) {
        const ccRuntime = getRuntime('claude-code');
        if (!ccRuntime?.resume) {
          return actionErrorResponse('Claude Code runtime not available.', 501);
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

        if (!result.ok) {
          return actionErrorResponse(result.note, 500);
        }

        return NextResponse.json(
          { ok: true, action, sessionKey, clientMutationId, status: 'sent', note: result.note },
          { status: 200, headers: NO_STORE_HEADERS },
        );
      }

      if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
        const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
        try {
          const { execFileSync } = await import('node:child_process');
          const os = await import('node:os');
          const path = await import('node:path');
          const codexBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
          const args = ['exec', 'resume', threadId, message ?? '', '--json', '--dangerously-bypass-approvals-and-sandbox'];
          const stdout = execFileSync(codexBin, args, {
            windowsHide: true,
            cwd: process.env.HOME || os.homedir(),
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            encoding: 'utf-8',
          });

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
            } catch {
              continue;
            }
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
            { status: 200, headers: NO_STORE_HEADERS },
          );
        } catch (error) {
          const message = sanitizeErrorMessage(error, 'Codex CLI error').slice(0, 200);
          console.error('[mobile/action] discovered codex CLI resume failed:', message);
          await publishMobileMutation(clientMutationId, {
            action,
            sessionKey,
            runtime: 'codex',
            status: 'failed',
            note: `Codex CLI error: ${message}`,
          });
          return actionErrorResponse(message, 500);
        }
      }

      return actionErrorResponse(`Don't know how to resume session: ${sessionKey.split(':')[0]}`, 501);
    }

    if (action === 'watch' || action === 'resolve') {
      if (!isOwnedCodex) {
        return actionErrorResponse(
          `${action} is only wired truthfully for IDE-owned Codex review packets on mobile right now.`,
          501,
        );
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

      if (result.status === 'unavailable') {
        return actionErrorResponse(result.note, 501);
      }

      return NextResponse.json(response, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    if (action !== 'steer' && action !== 'stop') {
      return actionErrorResponse(
        `${action} is part of the mobile control contract, but it is not wired truthfully on the current runtime lane yet.`,
        501,
      );
    }

    const result = await performRuntimeAction({
      action,
      surfaceId: sessionKey,
      clientMutationId,
      message: payload.message,
      attachments: payload.attachments,
      runId: payload.runId,
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
      runtime: result.runtime,
      status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
      note: result.note,
    });

    if (result.status === 'unavailable') {
      return actionErrorResponse(result.note, 501);
    }

    return NextResponse.json(response, {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error, 'Unable to perform mobile action');
    console.error('[mobile/action] request failed', {
      action,
      sessionKey,
      clientMutationId,
      error: message,
    });

    if (action && sessionKey) {
      try {
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          status: 'failed',
          note: message,
        });
      } catch (publishError) {
        console.error('[mobile/action] failed to publish mutation error', publishError);
      }
    }

    return actionErrorResponse(message, 500);
  }
}

/**
 * Persisted retry guard for explicit native control actions. The clone is used
 * only to inspect correlation/scope; the untouched Request still flows through
 * the existing handler, keeping every legacy and validation path byte-for-byte.
 */
export async function POST(request: NextRequest) {
  const probe = await request.clone().json().catch(() => null);
  const identity = resolveMobileActionIdempotencyIdentity(probe);
  if (!identity) return handleMobileActionPost(request);

  const key = deriveIdempotencyKey({
    verb: MOBILE_ACTION_IDEMPOTENCY_VERB,
    scopeId: identity.scopeId,
    clientKey: identity.clientMutationId,
  });
  const outcome = await withIdempotency<SerializedMobileActionResponse>({
    key,
    verb: MOBILE_ACTION_IDEMPOTENCY_VERB,
    scopeId: identity.scopeId,
    ttlMs: MOBILE_ACTION_IDEMPOTENCY_TTL_MS,
  }, async () => serializeMobileActionResponse(await handleMobileActionPost(request)));

  if (outcome.inProgress) {
    return NextResponse.json(mobileActionInProgressPayload(identity), {
      status: 202,
      headers: NO_STORE_HEADERS,
    });
  }

  return restoreMobileActionResponse(outcome.result, { replayed: outcome.replayed });
}
