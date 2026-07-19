'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { isTauri } from '@/lib/tauri/bridge';
import { CHROME, FONT, glassPop } from './ui';

type VoicePhase = 'listening' | 'processing' | 'working';

interface SttPayload {
  type?: string;
  origin?: string;
  lane?: string;
  text?: string;
}

interface AgentPayload {
  kind?: string;
  status?: string;
  intent?: string;
  tool?: string;
}

interface PillState {
  phase: VoicePhase;
  text: string;
  tools: string[];
}

const TERMINAL_STT = new Set(['system-idle', 'error', 'complete']);
const TERMINAL_AGENT = new Set(['done', 'failed', 'cancelled']);

const FALLBACK_TEXT: Record<VoicePhase, string> = {
  listening: 'Listening',
  processing: 'Working out the command',
  working: 'Symon is on it',
};

function compactToolName(tool: string): string {
  return tool.replace(/^o8_/, '').replace(/[-_]+/g, ' ').trim() || tool;
}

function textFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function SymonVoicePresencePill() {
  const prefersReducedMotion = useReducedMotion();
  const [state, setState] = useState<PillState | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentWindowUntilRef = useRef(0);
  const activeTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unsubs: Array<() => void> = [];

    const clearDismiss = () => {
      if (!dismissTimerRef.current) return;
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    };
    const show = (patch: Partial<PillState> & { phase: VoicePhase }) => {
      clearDismiss();
      setState((previous) => ({
        phase: patch.phase,
        text: patch.text ?? previous?.text ?? FALLBACK_TEXT[patch.phase],
        tools: patch.tools ?? previous?.tools ?? [],
      }));
    };
    const dismissSoon = () => {
      clearDismiss();
      dismissTimerRef.current = setTimeout(() => setState(null), 300);
    };
    const acceptsAgentEvent = (payload: AgentPayload & { taskId?: unknown }) => {
      const taskId = textFrom(payload.taskId);
      return Boolean(
        (taskId && taskId === activeTaskIdRef.current)
        || Date.now() < agentWindowUntilRef.current,
      );
    };

    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const add = (unlisten: () => void) => {
          if (disposed) unlisten();
          else unsubs.push(unlisten);
        };
        add(await listen<SttPayload>('o8:stt-event', (event) => {
          const payload = event.payload ?? {};
          if (payload.origin !== 'system') return;
          if (payload.type === 'system-start' && payload.lane === 'agent') {
            agentWindowUntilRef.current = Date.now() + 30_000;
            show({ phase: 'listening', text: FALLBACK_TEXT.listening, tools: [] });
            return;
          }
          if (TERMINAL_STT.has(payload.type ?? '')) {
            if (payload.type === 'error' || payload.type === 'complete') {
              agentWindowUntilRef.current = 0;
              activeTaskIdRef.current = null;
            }
            dismissSoon();
            return;
          }
          const isAgentSession = payload.lane === 'agent' || Date.now() < agentWindowUntilRef.current;
          if (!isAgentSession) return;
          const text = textFrom(payload.text);
          if (payload.type === 'partial' || payload.type === 'final') {
            show({ phase: 'listening', text: text || FALLBACK_TEXT.listening, tools: [] });
          } else if (payload.type === 'polished' || payload.type === 'status') {
            agentWindowUntilRef.current = Date.now() + 30_000;
            show({ phase: 'processing', text: text || FALLBACK_TEXT.processing, tools: [] });
          }
        }));
        add(await listen<AgentPayload & { taskId?: unknown }>('o8:agent-task-event', (event) => {
          const payload = event.payload ?? {};
          if (payload.kind === 'status') {
            if (TERMINAL_AGENT.has(payload.status ?? '')) {
              if (acceptsAgentEvent(payload)) {
                agentWindowUntilRef.current = 0;
                activeTaskIdRef.current = null;
                dismissSoon();
              }
              return;
            }
            if (payload.status === 'running' && acceptsAgentEvent(payload)) {
              activeTaskIdRef.current = textFrom(payload.taskId) || activeTaskIdRef.current;
              show({ phase: 'working', text: textFrom(payload.intent) || FALLBACK_TEXT.working });
            }
            return;
          }
          if (payload.kind === 'tool_call' && payload.tool && acceptsAgentEvent(payload)) {
            setState((previous) => {
              const tool = compactToolName(payload.tool!);
              const tools = [tool, ...(previous?.tools ?? [])].filter((item, index, arr) => arr.indexOf(item) === index).slice(0, 3);
              return {
                phase: 'working',
                text: previous?.text || FALLBACK_TEXT.working,
                tools,
              };
            });
          }
        }));
      })
      .catch(() => {});

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      agentWindowUntilRef.current = 0;
      activeTaskIdRef.current = null;
      dismissSoon();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      disposed = true;
      clearDismiss();
      window.removeEventListener('keydown', onKeyDown);
      for (const unsub of unsubs) {
        try { unsub(); } catch { /* noop */ }
      }
    };
  }, []);

  const label = state?.phase === 'listening' ? 'Listening' : state?.phase === 'processing' ? 'Thinking' : 'Working';

  return (
    <AnimatePresence>
      {state ? (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.985 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 28,
            transform: 'translateX(-50%)',
            zIndex: 90,
            pointerEvents: 'none',
          }}
        >
          <div
            role="status"
            aria-live="polite"
            style={{
              ...glassPop(),
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: 'min(560px, calc(100vw - 40px))',
              minHeight: 46,
              overflow: 'hidden',
              borderRadius: 999,
              paddingTop: 9,
              paddingBottom: 9,
              paddingLeft: 15,
              paddingRight: 15,
              pointerEvents: 'auto',
              fontFamily: FONT,
            }}
          >
            {state.phase === 'processing' && !prefersReducedMotion ? (
              <motion.span
                aria-hidden
                initial={{ x: '-120%' }}
                animate={{ x: '220%' }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                style={{
                  position: 'absolute',
                  top: -18,
                  bottom: -18,
                  width: 90,
                  background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--cnv-ink) 14%, transparent), transparent)',
                  filter: 'blur(10px)',
                  pointerEvents: 'none',
                }}
              />
            ) : null}
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: state.phase === 'processing' ? 'var(--t-warning, #f59e0b)' : 'var(--t-accent, var(--cnv-ink))',
                flexShrink: 0,
              }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', lineHeight: 1 }}>
                Symon · {label}
              </span>
              <span style={{ fontSize: CHROME.metaSize, fontWeight: CHROME.metaWeight, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {state.text || FALLBACK_TEXT[state.phase]}
              </span>
            </span>
            {state.tools.length ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 190, overflow: 'hidden', flexShrink: 0 }}>
                {state.tools.map((tool) => (
                  <span
                    key={tool}
                    style={{
                      maxWidth: 90,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      borderRadius: 999,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: 'var(--cnv-edge)',
                      background: 'var(--cnv-tint)',
                      color: 'var(--cnv-ink-muted)',
                      paddingTop: 3,
                      paddingBottom: 3,
                      paddingLeft: 8,
                      paddingRight: 8,
                      fontSize: 9.5,
                      fontWeight: 300,
                      lineHeight: 1,
                    }}
                  >
                    {tool}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
