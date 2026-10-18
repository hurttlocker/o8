import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { openOrchestratorWebSocket } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import type { LiveBackend } from './session';

export interface ManagedSymonConfirmation {
  callId: string; confirmationId: string; summary: string; tool: string; expiresAt: number; steps: string[];
  decide: (allow: boolean) => void;
}
let confirmation: ManagedSymonConfirmation | null = null;
const confirmationListeners = new Set<(value: ManagedSymonConfirmation | null) => void>();
export function subscribeManagedSymonConfirmation(listener: (value: ManagedSymonConfirmation | null) => void) {
  confirmationListeners.add(listener); listener(confirmation);
  return () => { confirmationListeners.delete(listener); };
}
function setConfirmation(value: ManagedSymonConfirmation | null) {
  confirmation = value; for (const listener of confirmationListeners) listener(value);
}
let retained: Promise<LiveBackend> | undefined;
/** The text session outlives each microphone connection. It owns persona,
 * history, configured planner, confirmations, and native tools through the
 * existing Symon websocket entry point. Voice never invokes tools directly.
 */
export function getManagedSymonBackend(): Promise<LiveBackend> {
  retained ??= createBackend().catch(error => { retained = undefined; throw error; });
  return retained;
}
async function createBackend(): Promise<LiveBackend> {
  let saved = ''; try { saved = sessionStorage.getItem('o8-managed-symon-session') ?? ''; } catch { /* unavailable storage */ }
  const response = await fetch(saved ? `/api/voice/live?symonSession=${encodeURIComponent(saved)}` : '/api/mobile/symon/text-session?managedVoice=1', {
    ...(saved ? {} : { method: 'POST', body: JSON.stringify({ workspaceMode: 'o8' }) }),
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` },
  });
  const result = await response.json();
  if (!response.ok || !result.session?.sessionId) throw new Error(saved
    ? 'The saved Symon session is unavailable. Explicitly start a new conversation; no task was replayed.'
    : 'The configured Symon backend is unavailable.');
  const sessionId: string = result.session.sessionId;
  try { sessionStorage.setItem('o8-managed-symon-session', sessionId); } catch { /* unavailable storage */ }
  let socket: WebSocket | null = null;
  let connecting: Promise<void> | undefined;
  let attached: ((frame: Record<string, unknown>) => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const history: string[] = [];
  const syncHistory = (transcript: unknown) => {
    if (!Array.isArray(transcript)) return;
    history.splice(0, history.length, ...transcript.flatMap(entry => entry && typeof entry.text === 'string'
      ? [`${entry.role === 'user' ? 'User' : 'Symon'}: ${entry.text}`] : []));
  };
  syncHistory(result.session.transcript);
  const turns = new Map<string, { text: string; output: string; update: (text: string, spoken?: boolean) => Promise<void>; resolve: () => void }>();
  const onMessage = (event: MessageEvent) => {
    let frame: Record<string, unknown>; try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.channel !== 'symon' || frame.sessionId !== sessionId) return;
    if (frame.type === 'symon-text-attached') {
      if (frame.ok === true) {
        syncHistory(frame.transcript);
        for (const replay of (Array.isArray(frame.turns) ? frame.turns : [])) {
          if (typeof replay.turnId !== 'string') continue;
          const existing = turns.get(replay.turnId);
          if (replay.status === 'running') {
            if (!existing) turns.set(replay.turnId, { text: '', output: '', update: async () => {}, resolve: () => {} });
          } else if (existing) {
            turns.delete(replay.turnId);
            void existing.update(replay.status === 'done' ? replay.text || 'The backend completed.' : `The backend reported ${replay.status}.`).catch(() => {}).finally(existing.resolve);
          }
        }
      }
      attached?.(frame); return;
    }
    if (frame.type === 'symon-confirm-settled') {
      if (confirmation?.callId === frame.callId && confirmation?.confirmationId === frame.confirmationId) setConfirmation(null);
      return;
    }
    if (frame.type === 'symon-confirm-required' && typeof frame.callId === 'string'
      && typeof frame.confirmationId === 'string' && typeof frame.summary === 'string'
      && typeof frame.tool === 'string' && typeof frame.expiresAt === 'number') {
      const task = turns.get(frame.callId);
      if (!task) return;
      let decided = false;
      const plan = frame.plan as { steps?: Array<{ summary?: string }> } | undefined;
      setConfirmation({ callId: frame.callId, confirmationId: frame.confirmationId, summary: frame.summary, tool: frame.tool, expiresAt: frame.expiresAt,
        steps: plan?.steps?.flatMap(step => typeof step.summary === 'string' ? [step.summary] : []) ?? [],
        decide: allow => {
          if (decided || Date.now() >= Number(frame.expiresAt) || socket?.readyState !== WebSocket.OPEN) return;
          decided = true;
          socket!.send(JSON.stringify({ channel: 'symon', type: 'symon-confirm-decision', sessionId,
            callId: frame.callId, confirmationId: frame.confirmationId, allow,
            clientMutationId: crypto.randomUUID(), protocolVersion: 2 }));
          setConfirmation(null);
        },
      });
      void task.update('This action needs approval in the Symon confirmation controls.').catch(() => {});
      return;
    }
    if (typeof frame.turnId !== 'string') return;
    const task = turns.get(frame.turnId); if (!task) return;
    if (frame.type === 'symon-text-delta' && typeof frame.delta === 'string') task.output += frame.delta;
    if (frame.type === 'symon-text-done') {
      if (frame.status === 'unconfirmed') { void task.update('The backend outcome is unconfirmed. Another task will not be started.').catch(() => {}); return; }
      turns.delete(frame.turnId);
      const answer = frame.status === 'interrupted' ? 'The backend confirmed this task was interrupted.'
        : frame.status === 'done' ? task.output : 'The backend did not complete this task. Check its conversation before retrying.';
      history.push(`User: ${task.text}`, `Symon: ${answer}`);
      if (history.length > 24) history.splice(0, history.length - 24);
      void task.update(answer || 'The backend completed without a spoken reply.').catch(() => {}).finally(task.resolve);
    }
  };
  const ensureConnected = async () => {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const opened = openOrchestratorWebSocket();
      if (!opened) throw new Error('Symon connection unavailable.');
      socket = opened;
      opened.addEventListener('message', event => { if (socket === opened) onMessage(event); });
      opened.addEventListener('close', () => {
        if (socket !== opened) return;
        clearInterval(heartbeat); setConfirmation(null);
        for (const task of turns.values()) void task.update('The backend transport disconnected. Work may continue; reconnect will reconcile the same session.').catch(() => {});
      });
      await new Promise<void>((resolve, reject) => {
        if (opened.readyState === WebSocket.OPEN) { resolve(); return; }
        const cleanup = () => { clearTimeout(timer); opened.removeEventListener('open', onOpen); opened.removeEventListener('error', onError); opened.removeEventListener('close', onClose); };
        const fail = (message: string) => { cleanup(); if (socket === opened) { clearInterval(heartbeat); socket = null; } opened.close(); reject(new Error(message)); };
        const onOpen = () => { cleanup(); resolve(); };
        const onError = () => fail('Symon connection failed.');
        const onClose = () => fail('Symon connection closed before opening.');
        const timer = setTimeout(() => fail('Symon connection timed out.'), 10_000);
        opened.addEventListener('open', onOpen); opened.addEventListener('error', onError); opened.addEventListener('close', onClose);
      });
      clearInterval(heartbeat); heartbeat = setInterval(() => { if (socket === opened && opened.readyState === WebSocket.OPEN) opened.send(JSON.stringify({ channel: 'symon', type: 'symon-text-attach', sessionId })); }, 30_000);
    })().finally(() => { connecting = undefined; });
    return connecting;
  };
  const reconcile = async () => {
    await ensureConnected();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { attached = undefined; reject(new Error('Symon reattachment was not confirmed.')); }, 10_000);
      attached = frame => {
        clearTimeout(timer); attached = undefined;
        if (frame.ok === true) resolve(); else reject(new Error(typeof frame.error === 'string' ? frame.error : 'Symon reattachment rejected.'));
      };
      socket!.send(JSON.stringify({ channel: 'symon', type: 'symon-text-attach', sessionId }));
    });
  };
  await reconcile();
  return {
    binding: `symon:${sessionId}:${result.session.engine}:${result.session.model}`,
    ready: reconcile,
    context: () => `You are Symon, speaking for the same existing Symon text session. Configured planner: ${result.session.engine}.\n${history.join('\n')}`,
    delegate: async (text, id, update) => {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Symon connection is unavailable; no action was replayed.');
      if (/^\s*(stop|cancel)(\s+(that|this|the task|working))?[.!]?\s*$/i.test(text)) {
        for (const [turnId, task] of turns) { turns.set(turnId, { ...task, update }); socket!.send(JSON.stringify({ channel: 'symon', type: 'symon-text-interrupt', sessionId, turnId })); }
        await update('Stop requested. Waiting for backend confirmation.');
        return;
      }
      if (turns.has(id)) return;
      if (turns.size) { await update('Symon is still working. This correction was not submitted; use the existing conversation control.'); return; }
      await new Promise<void>(resolve => {
        turns.set(id, { text, output: '', update, resolve });
        socket!.send(JSON.stringify({ channel: 'symon', type: 'symon-text-turn', sessionId, turnId: id, text }));
      });
    },
  };
}
