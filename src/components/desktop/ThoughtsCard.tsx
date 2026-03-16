'use client';

/**
 * ThoughtsCard — Floating glass command surface.
 *
 * Two modes:
 * - ISSUE: Full canonical workflow (create → assign → plan → review → execute)
 * - TASK: Mini-chat with your main agent right inside the card.
 *         Does NOT touch the main chat panel — independent channel.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ── Types ──

type ThoughtMode = 'pick' | 'issue' | 'task';
type WorkflowStep = 'idle' | 'thinking' | 'creating' | 'assigning' | 'planning' | 'reviewing' | 'executing' | 'done';

interface WorkflowState {
  step: WorkflowStep;
  issue?: string;
  repo?: string;
  agent?: string;
  plan?: string;
  summary?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ── SVG Icons ──

function GripIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, opacity: 0.4 }}>
      <circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/>
      <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
      <circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>
    </svg>
  );
}

function XIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function LoaderIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, animation: 'spin 1s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, opacity: 0.3 }}>
      <circle cx="12" cy="12" r="10"/>
    </svg>
  );
}

// ── Workflow Steps Config ──

const STEPS: { key: WorkflowStep; label: string }[] = [
  { key: 'thinking', label: 'Understanding intent' },
  { key: 'creating', label: 'Creating issue' },
  { key: 'assigning', label: 'Assigning agent' },
  { key: 'planning', label: 'Generating plan' },
  { key: 'reviewing', label: 'Awaiting review' },
  { key: 'executing', label: 'Agent executing' },
  { key: 'done', label: 'Complete' },
];

function stepIndex(step: WorkflowStep): number {
  const i = STEPS.findIndex(s => s.key === step);
  return i >= 0 ? i : -1;
}

function StepIndicator({ step, currentStep }: { step: WorkflowStep; currentStep: WorkflowStep }) {
  const si = stepIndex(step);
  const ci = stepIndex(currentStep);
  return ci > si ? (
    <div style={{ color: '#22c55e' }}><CheckIcon /></div>
  ) : ci === si ? (
    <div style={{ color: '#2563eb' }}><LoaderIcon /></div>
  ) : (
    <CircleIcon />
  );
}

// ── Main Component ──

interface ThoughtsCardProps {
  open: boolean;
  onClose: () => void;
}

const MAIN_SESSION_KEY = 'agent:main:main';

export function ThoughtsCard({ open, onClose }: ThoughtsCardProps) {
  const [mode, setMode] = useState<ThoughtMode>('pick');
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowState>({ step: 'idle' });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 400, h: 0 });
  const [initialized, setInitialized] = useState(false);

  // Task chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const sendTimestampRef = useRef<number>(0);
  const seenAssistantIdsRef = useRef<Set<string>>(new Set());

  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; corner: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Center on first open
  useEffect(() => {
    if (open && !initialized) {
      setPosition({
        x: Math.max(100, Math.round(window.innerWidth / 2 - 200)),
        y: Math.max(80, Math.round(window.innerHeight / 2 - 200)),
      });
      setInitialized(true);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, initialized]);

  // Focus input when un-minimized or mode changes
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, minimized, mode]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Auto-expand card when entering task mode
  useEffect(() => {
    if (mode === 'task' && size.h === 0) {
      setSize(prev => ({ ...prev, h: 420 }));
    }
  }, [mode, size.h]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Drag handlers ──

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: position.x, origY: position.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 200, dragRef.current.origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.origY + dy)),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [position]);

  // ── Resize handlers ──

  const handleResizeStart = useCallback((corner: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const currentH = cardRef.current?.getBoundingClientRect().height || 300;
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: currentH, corner };

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const dx = ev.clientX - resizeRef.current.startX;
      const dy = ev.clientY - resizeRef.current.startY;
      const c = resizeRef.current.corner;

      let newW = resizeRef.current.origW;
      let newH = resizeRef.current.origH;

      if (c.includes('e')) newW = Math.max(320, Math.min(800, resizeRef.current.origW + dx));
      if (c.includes('w')) {
        newW = Math.max(320, Math.min(800, resizeRef.current.origW - dx));
        setPosition(p => ({ ...p, x: Math.max(0, p.x + dx) }));
      }
      if (c.includes('s')) newH = Math.max(200, Math.min(700, resizeRef.current.origH + dy));

      setSize({ w: newW, h: newH });
    };

    const handleUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [size.w]);

  // ── Poll for agent response ──

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    let attempts = 0;
    const maxAttempts = 40; // 40 × 3s = 2 min max

    // 3s initial delay — give the agent time to start processing
    const timer = setTimeout(() => {
      pollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          if (pollRef.current) clearInterval(pollRef.current);
          setWaitingForReply(false);
          return;
        }

        try {
          const res = await fetch(
            `/api/mobile/history?sessionKey=${encodeURIComponent(MAIN_SESSION_KEY)}&limit=8&fresh=1`
          );
          if (!res.ok) return;
          const data = await res.json();
          const entries = data.transcript || data.entries || [];

          // Find assistant messages NEWER than our send timestamp
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            const entryText = (entry.text || entry.content || '').trim();
            const entryTs = entry.timestamp || 0;
            const entryId = entry.id || `a-${entryTs}-${i}`;

            if (
              entry.role === 'assistant' &&
              entryText &&
              entryText.length > 5 &&
              entryTs > sendTimestampRef.current &&
              !seenAssistantIdsRef.current.has(entryId)
            ) {
              // Skip tool-header-only messages
              if (entryText.startsWith('🔧')) continue;

              seenAssistantIdsRef.current.add(entryId);
              setChatMessages(prev => [
                ...prev,
                {
                  id: entryId,
                  role: 'assistant',
                  content: entryText,
                  timestamp: Date.now(),
                },
              ]);
              setWaitingForReply(false);
              if (pollRef.current) clearInterval(pollRef.current);
              return;
            }
          }
        } catch {
          // silent retry
        }
      }, 3000);
    }, 3000);

    // Store cleanup ref
    pollRef.current = timer as unknown as ReturnType<typeof setInterval>;
  }, []);

  // ── Issue mode: submit thought ──

  const handleIssueSubmit = useCallback(async () => {
    if (!input.trim()) return;
    const thought = input.trim();
    setInput('');

    setWorkflow({ step: 'thinking', summary: thought });

    try {
      const res = await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          sessionKey: MAIN_SESSION_KEY,
          message: `[Issue from Thoughts] ${thought}`,
        }),
      });

      if (res.ok) {
        setTimeout(() => setWorkflow(prev => ({ ...prev, step: 'creating' })), 1500);
        setTimeout(() => setWorkflow(prev => ({ ...prev, step: 'assigning', issue: 'pending', agent: 'Main Agent' })), 3000);
        setTimeout(() => setWorkflow(prev => ({ ...prev, step: 'planning' })), 4500);
        setTimeout(() => setWorkflow(prev => ({
          ...prev,
          step: 'reviewing',
          plan: 'Thought sent to your main OpenClaw agent. The agent will create the issue and propose a plan.',
        })), 6000);
      } else {
        setWorkflow(prev => ({
          ...prev,
          step: 'reviewing',
          plan: 'Failed to reach agent. Check that the gateway is running.',
        }));
      }
    } catch {
      setWorkflow(prev => ({
        ...prev,
        step: 'reviewing',
        plan: 'Connection error. Make sure the OpenClaw gateway is running.',
      }));
    }
  }, [input]);

  // ── Task mode: send chat message ──

  const handleTaskSend = useCallback(async () => {
    if (!input.trim() || waitingForReply) return;
    const msg = input.trim();
    setInput('');

    // Add user message to chat
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: msg,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, userMsg]);
    setWaitingForReply(true);

    try {
      // Snapshot ALL current assistant message IDs so we only detect genuinely new ones
      const snapRes = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(MAIN_SESSION_KEY)}&limit=8&fresh=1`);
      if (snapRes.ok) {
        const data = await snapRes.json();
        const entries = data.transcript || data.entries || [];
        for (const entry of entries) {
          if (entry.role === 'assistant') {
            const entryId = entry.id || `a-${entry.timestamp || 0}`;
            seenAssistantIdsRef.current.add(entryId);
          }
        }
      }

      // Record send timestamp — only accept responses AFTER this
      sendTimestampRef.current = Date.now();

      // Send via the action API
      await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          sessionKey: MAIN_SESSION_KEY,
          message: msg,
        }),
      });

      // Start polling for the response
      startPolling();
    } catch {
      setChatMessages(prev => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: 'Connection error. Make sure the OpenClaw gateway is running.',
          timestamp: Date.now(),
        },
      ]);
      setWaitingForReply(false);
    }
  }, [input, waitingForReply, startPolling]);

  const handleApprove = useCallback(() => {
    setWorkflow(prev => ({ ...prev, step: 'executing' }));
    setTimeout(() => setWorkflow(prev => ({ ...prev, step: 'done' })), 3000);
  }, []);

  const handleReset = useCallback(() => {
    setWorkflow({ step: 'idle' });
    setInput('');
    setPreEnhanceInput(null);
    setMode('pick');
    setChatMessages([]);
    setWaitingForReply(false);
    if (pollRef.current) clearInterval(pollRef.current);
    sendTimestampRef.current = 0;
    seenAssistantIdsRef.current.clear();
    setSize(prev => ({ ...prev, h: 0 }));
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setInput(data.enhanced);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput]);

  if (!open) return null;

  const isActive = workflow.step !== 'idle';
  const currentStepIdx = stepIndex(workflow.step);
  const inTaskChat = mode === 'task';

  // ── Render ──

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      `}</style>

      <div
        ref={cardRef}
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: minimized ? 220 : size.w,
          height: minimized ? 'auto' : (size.h > 0 ? size.h : 'auto'),
          zIndex: 9999,
          borderRadius: minimized ? 12 : 18,
          background: 'rgba(255, 255, 255, 0.45)',
          backdropFilter: 'blur(50px) saturate(180%)',
          WebkitBackdropFilter: 'blur(50px) saturate(180%)',
          border: '1px solid rgba(255, 255, 255, 0.35)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06), inset 0 0.5px 0 rgba(255,255,255,0.5)',
          overflow: 'visible',
          display: 'flex',
          flexDirection: 'column',
          transition: 'border-radius 250ms',
          fontFamily: '-apple-system, system-ui, BlinkMacSystemFont, sans-serif',
        }}
      >
        {/* ── Header — drag handle ── */}
        <div
          onMouseDown={handleDragStart}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: minimized ? '8px 12px' : '10px 14px',
            cursor: 'grab',
            userSelect: 'none',
            borderBottom: minimized ? 'none' : '1px solid rgba(0,0,0,0.04)',
            flexShrink: 0,
          }}
        >
          <GripIcon />
          <span style={{
            fontSize: 12, fontWeight: 700, color: '#111827',
            letterSpacing: '-0.01em', flex: 1,
          }}>
            {inTaskChat && chatMessages.length > 0 ? 'Task Chat' : 'Thoughts'}
          </span>
          {!minimized && mode !== 'pick' && !isActive && !inTaskChat && (
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 5,
              background: mode === 'issue' ? 'rgba(37,99,235,0.1)' : 'rgba(0,0,0,0.05)',
              color: mode === 'issue' ? '#2563eb' : '#6b7280',
              letterSpacing: '0.03em',
            }}>
              {mode === 'issue' ? 'Issue' : 'Task'}
            </span>
          )}
          {isActive && !minimized && !inTaskChat && (
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 5,
              background: workflow.step === 'done' ? 'rgba(34,197,94,0.1)' : 'rgba(37,99,235,0.1)',
              color: workflow.step === 'done' ? '#22c55e' : '#2563eb',
              letterSpacing: '0.03em',
            }}>
              {STEPS.find(s => s.key === workflow.step)?.label || workflow.step}
            </span>
          )}
          {inTaskChat && waitingForReply && !minimized && (
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 5,
              background: 'rgba(37,99,235,0.1)',
              color: '#2563eb',
              letterSpacing: '0.03em',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              Thinking...
            </span>
          )}
          {/* New Thought (resets) — only in task chat */}
          {inTaskChat && chatMessages.length > 0 && !minimized && (
            <button type="button" onClick={handleReset} title="New thought" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              color: '#9ca3af', display: 'flex', borderRadius: 6, fontSize: 11, fontWeight: 600,
            }}>
              New
            </button>
          )}
          <button type="button" onClick={() => setMinimized(v => !v)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: '#9ca3af', display: 'flex', borderRadius: 6,
          }}>
            <MinimizeIcon />
          </button>
          <button type="button" onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: '#9ca3af', display: 'flex', borderRadius: 6,
          }}>
            <XIcon />
          </button>
        </div>

        {/* ── Body ── */}
        {!minimized && (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: '0 0 18px 18px',
          }}>

            {/* ── MODE PICKER ── */}
            {mode === 'pick' && workflow.step === 'idle' && (
              <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* Issue button */}
                  <button
                    type="button"
                    onClick={() => { setMode('issue'); setTimeout(() => inputRef.current?.focus(), 50); }}
                    style={{
                      flex: 1, padding: '12px 14px', borderRadius: 12,
                      border: '1px solid rgba(37, 99, 235, 0.15)',
                      background: 'rgba(37, 99, 235, 0.06)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 120ms, border-color 120ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(37, 99, 235, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(37, 99, 235, 0.3)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(37, 99, 235, 0.06)';
                      e.currentTarget.style.borderColor = 'rgba(37, 99, 235, 0.15)';
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#2563eb', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block' }}>
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                      </svg>
                      Issue
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>
                      Creates a GitHub issue, assigns an agent, generates a plan for your review, then executes.
                    </div>
                  </button>

                  {/* Task button */}
                  <button
                    type="button"
                    onClick={() => { setMode('task'); setTimeout(() => inputRef.current?.focus(), 50); }}
                    style={{
                      flex: 1, padding: '12px 14px', borderRadius: 12,
                      border: '1px solid rgba(0, 0, 0, 0.08)',
                      background: 'rgba(0, 0, 0, 0.02)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 120ms, border-color 120ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                      e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 0, 0, 0.02)';
                      e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.08)';
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block' }}>
                        <polyline points="22 12 16 12 14 15 10 9 8 12 2 12"/>
                      </svg>
                      Task
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>
                      Quick chat with your main agent. Conversation stays right here — doesn&apos;t touch the main chat.
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* ── ISSUE MODE ── */}
            {mode === 'issue' && (
              <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                {/* Back + label */}
                {workflow.step === 'idle' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <button type="button" onClick={() => setMode('pick')} style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      fontSize: 11, color: '#9ca3af', fontWeight: 500,
                    }}>
                      ← back
                    </button>
                    <span style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                      padding: '2px 7px', borderRadius: 5, letterSpacing: '0.04em',
                      background: 'rgba(37, 99, 235, 0.1)', color: '#2563eb',
                    }}>
                      New Issue
                    </span>
                  </div>
                )}

                {/* Input */}
                {workflow.step === 'idle' && (
                  <div style={{ position: 'relative', flex: size.h > 0 ? 1 : undefined, display: 'flex', flexDirection: 'column' }}>
                    <textarea
                      ref={mode === 'issue' ? inputRef : undefined}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleIssueSubmit(); }
                      }}
                      placeholder="Describe the feature, bug, or change you need..."
                      style={{
                        width: '100%', minHeight: 72,
                        flex: size.h > 0 ? 1 : undefined,
                        maxHeight: size.h > 0 ? 'none' : 160,
                        padding: '10px 80px 10px 12px', borderRadius: 12,
                        border: '1px solid rgba(0,0,0,0.06)',
                        background: 'rgba(255,255,255,0.35)',
                        fontSize: 13, color: '#111827', resize: 'none',
                        outline: 'none', fontFamily: 'inherit', lineHeight: 1.5,
                        letterSpacing: '-0.01em', boxSizing: 'border-box',
                      }}
                    />
                    <InputButtons
                      input={input}
                      enhancing={enhancing}
                      preEnhanceInput={preEnhanceInput}
                      onEnhance={handleEnhance}
                      onUndoEnhance={handleUndoEnhance}
                      onSubmit={handleIssueSubmit}
                    />
                  </div>
                )}

                {/* Workflow summary */}
                {isActive && workflow.summary && (
                  <div style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: 'rgba(37, 99, 235, 0.06)',
                    border: '1px solid rgba(37, 99, 235, 0.1)',
                    marginBottom: 12, fontSize: 12, color: '#374151',
                    lineHeight: 1.5, fontStyle: 'italic',
                  }}>
                    &ldquo;{workflow.summary}&rdquo;
                  </div>
                )}

                {/* Workflow steps */}
                {isActive && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {STEPS.map((step) => {
                      if (step.key === 'done' && workflow.step !== 'done') return null;
                      const si = stepIndex(step.key);
                      if (si > currentStepIdx + 1 && workflow.step !== 'done') return null;
                      return (
                        <div key={step.key} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 0',
                          opacity: si > currentStepIdx ? 0.4 : 1,
                          transition: 'opacity 300ms',
                        }}>
                          <StepIndicator step={step.key} currentStep={workflow.step} />
                          <span style={{
                            fontSize: 12, color: si === currentStepIdx ? '#111827' : '#6b7280',
                            fontWeight: si === currentStepIdx ? 600 : 400,
                          }}>
                            {step.label}
                          </span>
                          {step.key === 'creating' && workflow.repo && si <= currentStepIdx && (
                            <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>{workflow.repo}</span>
                          )}
                          {step.key === 'assigning' && workflow.agent && si <= currentStepIdx && (
                            <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600, marginLeft: 'auto' }}>{workflow.agent}</span>
                          )}
                          {step.key === 'creating' && workflow.issue && si <= currentStepIdx && (
                            <span style={{ fontSize: 10, color: '#2563eb', fontWeight: 600, marginLeft: 4 }}>{workflow.issue}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Plan review */}
                {workflow.step === 'reviewing' && workflow.plan && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{
                      padding: '10px 12px', borderRadius: 10,
                      background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.06)',
                      fontSize: 11, color: '#374151', lineHeight: 1.6, marginBottom: 10,
                    }}>
                      {workflow.plan}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={handleApprove} style={{
                        flex: 1, padding: '8px 0', borderRadius: 10, border: 'none',
                        background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}>
                        Approve
                      </button>
                      <button type="button" style={{
                        flex: 1, padding: '8px 0', borderRadius: 10,
                        border: '1px solid rgba(0,0,0,0.1)', background: 'rgba(255,255,255,0.5)',
                        color: '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}>
                        Edit Plan
                      </button>
                    </div>
                  </div>
                )}

                {/* Done */}
                {workflow.step === 'done' && (
                  <div style={{ marginTop: 12 }}>
                    <button type="button" onClick={handleReset} style={{
                      width: '100%', padding: '8px 0', borderRadius: 10, border: 'none',
                      background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}>
                      New Thought
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── TASK MODE — Mini Chat ── */}
            {mode === 'task' && (
              <>
                {/* Chat messages area */}
                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '8px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}>
                  {/* Empty state */}
                  {chatMessages.length === 0 && !waitingForReply && (
                    <div style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      justifyContent: 'center', flex: 1, gap: 6, padding: '20px 0',
                    }}>
                      <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', lineHeight: 1.5 }}>
                        Quick chat with your main agent.<br/>
                        The main chat panel stays untouched.
                      </div>
                      <button type="button" onClick={() => setMode('pick')} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 10, color: '#9ca3af', fontWeight: 500, marginTop: 4,
                      }}>
                        ← back to picker
                      </button>
                    </div>
                  )}

                  {/* Messages */}
                  {chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%',
                        padding: '8px 12px',
                        borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        background: msg.role === 'user'
                          ? 'rgba(37, 99, 235, 0.12)'
                          : 'rgba(255, 255, 255, 0.6)',
                        border: msg.role === 'user'
                          ? '1px solid rgba(37, 99, 235, 0.15)'
                          : '1px solid rgba(0,0,0,0.06)',
                        fontSize: 12,
                        color: '#111827',
                        lineHeight: 1.5,
                        letterSpacing: '-0.01em',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {msg.content}
                    </div>
                  ))}

                  {/* Typing indicator */}
                  {waitingForReply && (
                    <div style={{
                      alignSelf: 'flex-start',
                      padding: '8px 14px',
                      borderRadius: '14px 14px 14px 4px',
                      background: 'rgba(255, 255, 255, 0.6)',
                      border: '1px solid rgba(0,0,0,0.06)',
                      display: 'flex', gap: 4, alignItems: 'center',
                    }}>
                      {[0, 1, 2].map((i) => (
                        <div key={i} style={{
                          width: 5, height: 5, borderRadius: '50%',
                          background: '#9ca3af',
                          animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                        }} />
                      ))}
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                {/* Compose bar */}
                <div style={{
                  padding: '8px 12px 12px',
                  borderTop: '1px solid rgba(0,0,0,0.04)',
                  flexShrink: 0,
                }}>
                  <div style={{ position: 'relative' }}>
                    <textarea
                      ref={mode === 'task' ? inputRef : undefined}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTaskSend(); }
                      }}
                      placeholder={waitingForReply ? 'Agent is thinking...' : 'Ask your agent anything...'}
                      disabled={waitingForReply}
                      rows={1}
                      style={{
                        width: '100%', minHeight: 36, maxHeight: 80,
                        padding: '8px 76px 8px 12px', borderRadius: 12,
                        border: '1px solid rgba(0,0,0,0.06)',
                        background: waitingForReply ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.35)',
                        fontSize: 12, color: '#111827', resize: 'none',
                        outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
                        boxSizing: 'border-box',
                        opacity: waitingForReply ? 0.5 : 1,
                      }}
                    />
                    <InputButtons
                      input={input}
                      enhancing={enhancing}
                      preEnhanceInput={preEnhanceInput}
                      onEnhance={handleEnhance}
                      onUndoEnhance={handleUndoEnhance}
                      onSubmit={handleTaskSend}
                      small
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Resize handles ── */}
        {!minimized && (
          <>
            <div onMouseDown={handleResizeStart('e')} style={{
              position: 'absolute', top: 20, right: -3, bottom: 20, width: 6,
              cursor: 'ew-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('s')} style={{
              position: 'absolute', bottom: -3, left: 20, right: 20, height: 6,
              cursor: 'ns-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('se')} style={{
              position: 'absolute', bottom: -3, right: -3, width: 14, height: 14,
              cursor: 'nwse-resize', zIndex: 3,
            }} />
            <div onMouseDown={handleResizeStart('sw')} style={{
              position: 'absolute', bottom: -3, left: -3, width: 14, height: 14,
              cursor: 'nesw-resize', zIndex: 3,
            }} />
          </>
        )}
      </div>
    </>
  );
}

// ── Input Buttons (shared between Issue and Task compose) ──

function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  small,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSubmit: () => void;
  small?: boolean;
}) {
  const sz = small ? 24 : 28;
  const sendSz = small ? 26 : 30;

  return (
    <div style={{
      position: 'absolute',
      right: 6,
      bottom: 6,
      display: 'flex',
      gap: 3,
      alignItems: 'center',
    }}>
      {preEnhanceInput !== null && (
        <button type="button" onClick={onUndoEnhance} title="Undo enhancement" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>
          ↩
        </button>
      )}
      <button type="button" onClick={onEnhance} disabled={!input.trim() || enhancing}
        title="Enhance with AI" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: input.trim() ? 'rgba(37, 99, 235, 0.1)' : 'rgba(0,0,0,0.04)',
          color: enhancing ? '#93c5fd' : input.trim() ? '#2563eb' : '#b0b8c4',
          cursor: input.trim() && !enhancing ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 120ms, color 120ms',
          animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
        }}>
        <SparklesIcon />
      </button>
      <button type="button" onClick={onSubmit} disabled={!input.trim()} style={{
        width: sendSz, height: sendSz, borderRadius: 8, border: 'none',
        background: input.trim() ? '#2563eb' : 'rgba(0,0,0,0.06)',
        color: input.trim() ? '#fff' : '#b0b8c4',
        cursor: input.trim() ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 120ms',
      }}>
        <SendIcon />
      </button>
    </div>
  );
}
