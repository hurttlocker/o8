/**
 * turn-dispatcher — centralized resume-mode selection for all agent runtimes.
 *
 * Problem: every adapter (Codex, Claude Code, Gemini, opencode) independently
 * branches on how to resume a session — different CLI flags, thread-id formats,
 * and fallback strategies. This module extracts that branching into a single
 * place so new adapters declare a DispatchCapability and get correct mode
 * selection for free.
 *
 * Three modes (preference-ordered in DispatchCapability.modes):
 *
 *   one-shot          — runtime has no follow-up concept; reject resume calls.
 *   thread-resume     — runtime holds a durable thread id; pass it to the CLI.
 *   append-transcript — stateless CLI; prepend prior turns to the next prompt.
 *
 * NOTE: append-transcript is lossy for tool outputs — runtimes that emit
 * structured tool results (function-call / tool-use blocks) must serialize them
 * to text inside loadTranscript(), or tool history will not carry across turns.
 *
 * Adapters migrate in Wave 2b/2c. This file is additive; callers still invoke
 * adapter.resume() directly until migration is complete.
 */

import type { RuntimeActionResult } from '../types';

// ── Public types ──────────────────────────────────────────────────────────────

export type DispatchMode = 'one-shot' | 'thread-resume' | 'append-transcript';

/**
 * What a runtime adapter can do when asked to send a follow-up message.
 * Declare this on the adapter and pass it to dispatchTurn().
 */
export interface DispatchCapability {
  /**
   * Preferred mode order. dispatchTurn() walks the list and uses the first
   * mode that can be satisfied (non-null thread id, non-empty transcript, etc.).
   */
  modes: DispatchMode[];

  /**
   * thread-resume: resolve the persisted thread id for sessionKey.
   * Return null to fall through to the next preferred mode.
   */
  resolveThreadId?: (sessionKey: string) => Promise<string | null>;

  /**
   * append-transcript: load prior turns for sessionKey.
   * Return an empty array to fall through to the next preferred mode.
   */
  loadTranscript?: (
    sessionKey: string,
  ) => Promise<Array<{ role: 'user' | 'assistant'; text: string }>>;

  /**
   * append-transcript: build the combined prompt from prior turns + new message.
   * If omitted, a simple newline-separated format is used.
   */
  formatTranscriptPrompt?: (
    turns: Array<{ role: string; text: string }>,
    userMessage: string,
  ) => string;

  /** Adapter-specific hints forwarded to DispatchExecutor.spawn(), e.g. preferredFlag. */
  metadata?: Record<string, unknown>;
}

/**
 * Input describing the turn to dispatch.
 */
export interface DispatchRequest {
  sessionKey: string;
  message: string;
  cwd: string;
  model?: string;
  laneId?: string;
}

/**
 * The adapter-provided spawner. dispatchTurn() resolves mode + context, then
 * calls executor.spawn() once with the right arguments.
 */
export interface DispatchExecutor {
  spawn(ctx: {
    mode: DispatchMode;
    /** Final prompt to pass to the CLI — may include prepended transcript. */
    prompt: string;
    /** Non-null only for thread-resume. */
    threadId: string | null;
    cwd: string;
    model?: string;
  }): Promise<{ ok: boolean; note: string; sessionKey?: string }>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function defaultFormatTranscript(
  turns: Array<{ role: string; text: string }>,
  userMessage: string,
): string {
  const history = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
  return history ? `${history}\n\nUser: ${userMessage}` : userMessage;
}

// ── Core dispatcher ───────────────────────────────────────────────────────────

/**
 * Dispatch a single follow-up turn using the best available mode.
 *
 * Mode walk (capability.modes in preference order):
 *
 *   one-shot          → immediate ok:false (adapter has no resume support)
 *   thread-resume     → resolveThreadId(); null → try next mode
 *   append-transcript → loadTranscript(); empty → try next mode
 *
 * If no mode succeeds, returns ok:false with a descriptive note.
 */
export async function dispatchTurn(
  req: DispatchRequest,
  capability: DispatchCapability,
  executor: DispatchExecutor,
): Promise<RuntimeActionResult> {
  const { sessionKey, message, cwd, model } = req;

  if (!capability.modes || capability.modes.length === 0) {
    console.error('[turn-dispatcher] capability.modes is empty for', sessionKey);
    return { ok: false, note: 'No dispatch modes configured for this runtime.' };
  }

  for (const mode of capability.modes) {
    // ── one-shot ──────────────────────────────────────────────────────────────
    if (mode === 'one-shot') {
      console.log('[turn-dispatcher] mode=one-shot: rejecting resume for', sessionKey);
      return {
        ok: false,
        note: 'This runtime does not support follow-up messages (one-shot mode).',
      };
    }

    // ── thread-resume ─────────────────────────────────────────────────────────
    if (mode === 'thread-resume') {
      if (!capability.resolveThreadId) {
        console.warn(
          '[turn-dispatcher] thread-resume in modes but resolveThreadId not provided; skipping',
          sessionKey,
        );
        continue;
      }

      let threadId: string | null = null;
      try {
        threadId = await capability.resolveThreadId(sessionKey);
      } catch (err) {
        console.warn('[turn-dispatcher] resolveThreadId threw, falling through:', err);
        continue;
      }

      if (!threadId) {
        console.log(
          '[turn-dispatcher] thread-resume: no thread id resolved, trying next mode',
          sessionKey,
        );
        continue;
      }

      console.log('[turn-dispatcher] mode=thread-resume threadId=%s session=%s', threadId, sessionKey);
      try {
        const result = await executor.spawn({ mode, prompt: message, threadId, cwd, model });
        return {
          ok: result.ok,
          note: result.note,
          sessionKey: result.sessionKey ?? sessionKey,
        };
      } catch (err) {
        return {
          ok: false,
          note: `thread-resume spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── append-transcript ─────────────────────────────────────────────────────
    if (mode === 'append-transcript') {
      if (!capability.loadTranscript) {
        console.warn(
          '[turn-dispatcher] append-transcript in modes but loadTranscript not provided; skipping',
          sessionKey,
        );
        continue;
      }

      let turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
      try {
        turns = await capability.loadTranscript(sessionKey);
      } catch (err) {
        console.warn('[turn-dispatcher] loadTranscript threw, falling through:', err);
        continue;
      }

      if (turns.length === 0) {
        console.log(
          '[turn-dispatcher] append-transcript: empty transcript, trying next mode',
          sessionKey,
        );
        continue;
      }

      const format = capability.formatTranscriptPrompt ?? defaultFormatTranscript;
      const prompt = format(turns, message);

      console.log(
        '[turn-dispatcher] mode=append-transcript turns=%d session=%s',
        turns.length,
        sessionKey,
      );
      try {
        const result = await executor.spawn({ mode, prompt, threadId: null, cwd, model });
        return {
          ok: result.ok,
          note: result.note,
          sessionKey: result.sessionKey ?? sessionKey,
        };
      } catch (err) {
        return {
          ok: false,
          note: `append-transcript spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  // All modes exhausted without success.
  console.error('[turn-dispatcher] all modes exhausted for', sessionKey, capability.modes);
  return {
    ok: false,
    note: `Could not dispatch turn — all modes exhausted (tried: ${capability.modes.join(', ')}).`,
  };
}
