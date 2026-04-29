'use client';

/**
 * useSuggestedReplies — manages the per-message chip cache + Gemini fetch.
 *
 * One in-flight fetch at a time. Cached by message id so re-renders don't
 * re-fetch. Dismissals are sticky for the lifetime of the thread.
 *
 * Closes #771.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

interface UseSuggestedRepliesOptions {
  /** Whether the chat is currently in orchestrator mode (chips only show here). */
  enabled: boolean;
  /** Live transcript. The hook watches the LAST assistant message. */
  messages: MobileTranscriptEntry[];
  /** True while the orchestrator is streaming — chips become disabled. */
  isStreaming: boolean;
}

interface SuggestionsResponse {
  messageId?: string;
  suggestions?: unknown;
}

const MAX_CONTEXT_TURNS = 4;
const MIN_ASSISTANT_LEN = 12;
// #847 — when the suggestions endpoint fails (network error or non-OK status),
// back off for this window before retrying. Without this, every dependency
// change (scroll, resize, upstream state update) re-fires the fetch and
// produces a network storm against a known-broken endpoint.
const ERROR_COOLDOWN_MS = 10_000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === 'string');
}

export function useSuggestedReplies({ enabled, messages, isStreaming }: UseSuggestedRepliesOptions) {
  const [chipsByMessage, setChipsByMessage] = useState<Map<string, string[]>>(new Map());
  const [dismissedMessages, setDismissedMessages] = useState<Set<string>>(new Set());
  const inflightRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  // #847 — per-message cooldown timestamps (millis). When set, the effect
  // skips that message id until Date.now() exceeds the timestamp. Stored as
  // a ref + a tick state so a setTimeout can wake the effect when the window
  // elapses without binding the effect to wall-clock changes.
  const errorCooldownRef = useRef<Map<string, number>>(new Map());
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cooldownTick, setCooldownTick] = useState(0);

  // Identify the last assistant message; that's the only one we ever attach
  // chips to. Chips on older assistant messages aren't useful and would be
  // noisy.
  const lastAssistantId = useMemo(() => {
    if (!enabled) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const entry = messages[i];
      if (entry?.role === 'assistant' && (entry.text ?? '').trim().length > 0) {
        return entry.id;
      }
    }
    return null;
  }, [enabled, messages]);

  // Fetch chips for the current last assistant when needed.
  useEffect(() => {
    if (!enabled || !lastAssistantId || isStreaming) return;
    if (chipsByMessage.has(lastAssistantId)) return;
    if (dismissedMessages.has(lastAssistantId)) return;
    if (inflightRef.current.has(lastAssistantId)) return;
    // #847 — respect error cooldown. If a previous fetch failed within
    // ERROR_COOLDOWN_MS, schedule a wake-up tick at the cooldown's end and
    // bail. Subsequent dependency changes will re-evaluate; without the
    // wake-up the effect would never retry on its own once deps stop
    // changing.
    const cooldownUntil = errorCooldownRef.current.get(lastAssistantId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      if (cooldownTimerRef.current === null) {
        const remaining = Math.max(0, cooldownUntil - Date.now());
        cooldownTimerRef.current = setTimeout(() => {
          cooldownTimerRef.current = null;
          setCooldownTick((tick) => tick + 1);
        }, remaining + 25);
      }
      return;
    }

    const target = messages.find((m) => m.id === lastAssistantId);
    if (!target) return;
    const assistantText = (target.text ?? '').trim();
    if (assistantText.length < MIN_ASSISTANT_LEN) return;

    // Build a small recent-context window (the most recent N entries before
    // the target message). Stripped to plain {role, text} so we don't ship
    // tool-call payloads to the suggestion endpoint.
    const targetIndex = messages.findIndex((m) => m.id === lastAssistantId);
    const window = targetIndex >= 0
      ? messages
          .slice(Math.max(0, targetIndex - MAX_CONTEXT_TURNS), targetIndex)
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, text: (m.text ?? '').trim() }))
          .filter((m) => m.text.length > 0)
      : [];

    inflightRef.current.add(lastAssistantId);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      try {
        const res = await fetch('/api/v2/chat/suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: lastAssistantId,
            assistantText,
            recentContext: window,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // #847 — non-OK status (e.g. 500 from #844 thinking-budget starvation)
          // arms the cooldown so we don't fetch-storm against a broken endpoint.
          errorCooldownRef.current.set(lastAssistantId, Date.now() + ERROR_COOLDOWN_MS);
          return;
        }
        const data = await res.json() as SuggestionsResponse;
        const suggestions = isStringArray(data.suggestions) ? data.suggestions : [];
        // Successful fetch — clear any prior cooldown for this message id.
        errorCooldownRef.current.delete(lastAssistantId);
        setChipsByMessage((prev) => {
          const next = new Map(prev);
          next.set(lastAssistantId, suggestions);
          return next;
        });
      } catch (err) {
        // #847 — distinguish abort from real failures. Aborts happen when the
        // last-assistant id changes mid-flight; those should stay retryable.
        // Real network errors arm the cooldown.
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (!isAbort) {
          errorCooldownRef.current.set(lastAssistantId, Date.now() + ERROR_COOLDOWN_MS);
        }
      } finally {
        inflightRef.current.delete(lastAssistantId);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [chipsByMessage, dismissedMessages, enabled, isStreaming, lastAssistantId, messages, cooldownTick]);

  // When messages collapse to nothing (e.g. reset/clear), drop caches so a new
  // thread starts clean.
  useEffect(() => {
    if (messages.length === 0) {
      setChipsByMessage((prev) => (prev.size === 0 ? prev : new Map()));
      setDismissedMessages((prev) => (prev.size === 0 ? prev : new Set()));
      inflightRef.current.clear();
      errorCooldownRef.current.clear();
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    }
  }, [messages.length]);

  // Cleanup any pending cooldown timer when the hook unmounts.
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current !== null) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
  }, []);

  const chipsForLastAssistant = useMemo(() => {
    if (!enabled || !lastAssistantId) return [];
    if (dismissedMessages.has(lastAssistantId)) return [];
    return chipsByMessage.get(lastAssistantId) ?? [];
  }, [chipsByMessage, dismissedMessages, enabled, lastAssistantId]);

  const dismissChips = useCallback(() => {
    if (!lastAssistantId) return;
    setDismissedMessages((prev) => {
      if (prev.has(lastAssistantId)) return prev;
      const next = new Set(prev);
      next.add(lastAssistantId);
      return next;
    });
  }, [lastAssistantId]);

  return {
    lastAssistantId,
    chipsForLastAssistant,
    dismissChips,
  };
}
