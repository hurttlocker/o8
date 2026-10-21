import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { LiveEvent, LiveState } from '@/lib/voice/managed-live/session';
import type { VisualInstructionTarget } from './visual-instruction';
import type { VisualInstructionDraft } from './visual-draft-store';

export interface VisualLiveScope { principal: string; target: VisualInstructionTarget; routing: ComposerQueuePayload['routing'] }
const scopeKey = (scope: VisualLiveScope) => JSON.stringify([scope.principal, scope.target.repoPath, scope.target.threadId,
  Object.entries(scope.routing).filter(([key]) => key !== 'pinBackend').sort(([a], [b]) => a.localeCompare(b))]);
interface CaptureOwner { id: string; scope: VisualLiveScope; shared: boolean; prepare: (text: string, afterTaskId?: string) => Promise<VisualInstructionDraft> }
let capture: CaptureOwner | null = null;
let live: { binding: string; scope: VisualLiveScope; state: LiveState } | null = null;
export interface VisualSpeechFragment { id: string; text: string; startMs: number; endMs: number; sessionId: string; receivedAtMs: number }
const stateListeners = new Set<() => void>();
export function subscribeVisualVoiceState(listener: () => void) { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; }
export function sharedVisualVoiceState(scope: VisualLiveScope): LiveState | null { return live && scopeKey(live.scope) === scopeKey(scope) ? live.state : null; }
const speech = new Set<(fragment: VisualSpeechFragment) => void>();
const seen = new Set<string>();
export function visualLiveState(scope: VisualLiveScope): 'matching' | 'other' | 'none' {
  if (!live || ['closed', 'error', 'idle'].includes(live.state)) return 'none';
  return scopeKey(live.scope) === scopeKey(scope) && ['live', 'connecting'].includes(live.state) ? 'matching' : 'other';
}
export function claimVisualAudio(owner: CaptureOwner) {
  const state = visualLiveState(owner.scope);
  if (owner.shared !== (state === 'matching')) throw new Error('Voice ownership changed while the capture was being prepared. Start the capture again.');
  if (capture || state === 'other') throw new Error('Another chat owns voice. Finish that voice session before capturing here.');
  capture = owner;
  return () => { if (capture === owner) capture = null; };
}
export function registerVisualLive(scope: VisualLiveScope, binding: string) {
  if (capture && (!capture.shared || scopeKey(capture.scope) !== scopeKey(scope))) throw new Error('Finish the current visual recording before starting Live voice. Its draft is retained.');
  if (live && live.binding !== binding && !['closed', 'error', 'idle'].includes(live.state)) throw new Error('Another chat still owns voice.');
  const owner = { scope, binding, state: 'connecting' as LiveState }; live = owner;
  return {
    state: (state: LiveState) => { if (live === owner) { owner.state = state; if (state === 'closed' || state === 'error') { live = null; seen.clear(); } stateListeners.forEach(listener => listener()); } },
    input: (event: LiveEvent, sessionId: string) => {
      if (live !== owner || owner.state !== 'live' || event.type !== 'session.input_transcript.delta'
        || typeof event.event_id !== 'string' || typeof event.delta !== 'string' || seen.has(`${sessionId}:${event.event_id}`)
        || typeof event.start_ms !== 'number' || !Number.isFinite(event.start_ms) || event.start_ms < 0
        || typeof event.end_ms !== 'number' || !Number.isFinite(event.end_ms) || event.end_ms < event.start_ms) return;
      seen.add(`${sessionId}:${event.event_id}`); if (seen.size > 2048) seen.delete(seen.values().next().value!);
      if (capture?.shared && scopeKey(capture.scope) === scopeKey(scope)) speech.forEach(listener => listener({ id: String(event.event_id), text: String(event.delta), startMs: Number(event.start_ms), endMs: Number(event.end_ms), sessionId, receivedAtMs: Date.now() }));
    },
  };
}
export function subscribeVisualSpeech(listener: (fragment: VisualSpeechFragment) => void) { speech.add(listener); return () => { speech.delete(listener); }; }
export function prepareLiveVisual(scope: VisualLiveScope, text: string, afterTaskId?: string): Promise<VisualInstructionDraft> | null {
  if (!capture || scopeKey(capture.scope) !== scopeKey(scope)) return null;
  return capture.prepare(text, afterTaskId);
}
export function sameVisualRouting(scope: VisualLiveScope, draft: VisualInstructionDraft) {
  return scopeKey(scope) === scopeKey({ principal: draft.principal, target: draft.request.target, routing: draft.template.routing });
}
