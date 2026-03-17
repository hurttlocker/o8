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

interface PendingApproval {
  id: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  command?: string;
  risk: 'low' | 'medium' | 'high';
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
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

interface FleetAgent {
  name?: string;
  status?: string;
  currentTask?: string;
  context?: { usedPercent?: number };
  alerts?: number;
  sessionKey?: string;
  model?: string;
  lastEventAt?: string;
  activity?: { headline?: string };
}

interface ContextSuggestion {
  text: string;
  action: string; // pre-filled message
  agent: AgentTarget;
  priority: 'info' | 'warn' | 'critical';
}

interface ThoughtsCardProps {
  open: boolean;
  onClose: () => void;
  agents?: FleetAgent[];
}

interface AgentTarget {
  key: string;
  name: string;
  emoji: string;
  color: string;
}

const AGENTS: AgentTarget[] = [
  { key: 'agent:main:main', name: 'Mister', emoji: '', color: '#111827' },
  { key: 'agent:ace:main', name: 'Niot', emoji: '', color: '#2563eb' },
  { key: 'agent:hawk:main', name: 'Hawk', emoji: '', color: '#f59e0b' },
];

function generateSuggestions(agents: FleetAgent[]): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const agentMap = new Map(AGENTS.map(a => [a.name.toLowerCase(), a]));

  for (const agent of agents) {
    const name = agent.name || 'Unknown';
    const target = agentMap.get(name.toLowerCase()) || AGENTS[0];

    // Context pressure warning
    const ctx = agent.context?.usedPercent ?? 0;
    if (ctx > 80) {
      suggestions.push({
        text: `${name} is at ${Math.round(ctx)}% context — approaching limit`,
        action: `What's your context status? Do you need to compact?`,
        agent: target,
        priority: ctx > 90 ? 'critical' : 'warn',
      });
    }

    // Agent stuck / failed
    if (agent.status === 'failed' || agent.status === 'error') {
      suggestions.push({
        text: `${name} has failed — may need intervention`,
        action: `What happened? Can you recover?`,
        agent: target,
        priority: 'critical',
      });
    }

    // Agent idle for a while with a task
    if (agent.status === 'idle' && agent.currentTask) {
      const lastEvent = agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : 0;
      const idleMinutes = lastEvent ? (Date.now() - lastEvent) / 60000 : 0;
      if (idleMinutes > 30) {
        suggestions.push({
          text: `${name} has been idle ${Math.round(idleMinutes)}min with task: "${agent.currentTask}"`,
          action: `Status update on "${agent.currentTask}"?`,
          agent: target,
          priority: 'warn',
        });
      }
    }

    // Alerts
    if (agent.alerts && agent.alerts > 0) {
      suggestions.push({
        text: `${name} has ${agent.alerts} alert${agent.alerts > 1 ? 's' : ''}`,
        action: `What alerts do you have? Anything I should know?`,
        agent: target,
        priority: 'warn',
      });
    }
  }

  // Sort: critical first, then warn, then info
  const priorityOrder = { critical: 0, warn: 1, info: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions.slice(0, 3); // max 3 suggestions
}

export function ThoughtsCard({ open, onClose, agents = [] }: ThoughtsCardProps) {
  const [mode, setMode] = useState<ThoughtMode>('pick');
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [targetAgent, setTargetAgent] = useState(AGENTS[0]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
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

  // Approval state
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const approvalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // ── Approval polling — runs whenever card is open ──
  useEffect(() => {
    if (!open) return;

    const pollApprovals = async () => {
      try {
        const res = await fetch('/api/panel/approvals');
        if (res.ok) {
          const data = await res.json();
          setApprovals(data.approvals || []);
        }
      } catch { /* silent */ }
    };

    pollApprovals(); // immediate
    // Poll fast only when likely to have approvals (agent running), otherwise slow
    approvalPollRef.current = setInterval(pollApprovals, 15_000);

    return () => {
      if (approvalPollRef.current) clearInterval(approvalPollRef.current);
    };
  }, [open]);

  // ── Approval handlers ──
  const handleApprovalResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolvingId(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        setApprovals(prev => prev.filter(a => a.id !== id));
      }
    } catch { /* silent */ }
    setResolvingId(null);
  }, []);

  const handleTestApproval = useCallback(async () => {
    try {
      await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      // Next poll will pick it up, or force immediate
      const res = await fetch('/api/panel/approvals');
      if (res.ok) {
        const data = await res.json();
        setApprovals(data.approvals || []);
      }
    } catch { /* silent */ }
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
            `/api/mobile/history?sessionKey=${encodeURIComponent(targetAgent.key)}&limit=8&fresh=1`
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
          sessionKey: targetAgent.key,
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
      const snapRes = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(targetAgent.key)}&limit=8&fresh=1`);
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
          sessionKey: targetAgent.key,
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
    setTargetAgent(AGENTS[0]);
    setAgentPickerOpen(false);
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
  const suggestions = generateSuggestions(agents);

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
          zIndex: 10001,
          borderRadius: minimized ? 12 : 18,
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(50px) saturate(180%)',
          WebkitBackdropFilter: 'blur(50px) saturate(180%)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: 'var(--t-panel-shadow)',
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
            borderBottom: minimized ? 'none' : '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          <GripIcon />
          <span style={{
            fontSize: 12, fontWeight: 700, color: 'var(--t-text)',
            letterSpacing: '-0.01em', flex: 1,
          }}>
            {inTaskChat && chatMessages.length > 0 ? targetAgent.name : 'Thoughts'}
          </span>
          {/* Approval count badge */}
          {approvals.length > 0 && (
            <span style={{
              minWidth: 18, height: 18, borderRadius: 9,
              background: '#ef4444', color: '#fff',
              fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 5px', letterSpacing: 0,
              animation: 'pulse 2s ease-in-out infinite',
            }}>
              {approvals.length}
            </span>
          )}
          {!minimized && mode !== 'pick' && !isActive && !inTaskChat && (
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 5,
              background: mode === 'issue' ? 'rgba(37,99,235,0.1)' : 'var(--t-hover)',
              color: mode === 'issue' ? '#2563eb' : 'var(--t-text-secondary)',
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
              color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6, fontSize: 11, fontWeight: 600,
            }}>
              New
            </button>
          )}
          <button type="button" onClick={() => setMinimized(v => !v)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
          }}>
            <MinimizeIcon />
          </button>
          <button type="button" onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
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

            {/* ── APPROVAL CARDS — float above everything ── */}
            {approvals.length > 0 && (
              <div style={{
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderBottom: '1px solid var(--t-divider)',
                flexShrink: 0,
                maxHeight: 200,
                overflowY: 'auto',
              }}>
                {approvals.map((approval) => (
                  <div key={approval.id} style={{
                    padding: '10px 12px',
                    borderRadius: 14,
                    background: approval.risk === 'high'
                      ? 'rgba(239, 68, 68, 0.06)'
                      : approval.risk === 'medium'
                      ? 'rgba(245, 158, 11, 0.06)'
                      : 'rgba(37, 99, 235, 0.06)',
                    border: `1px solid ${
                      approval.risk === 'high'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : approval.risk === 'medium'
                        ? 'rgba(245, 158, 11, 0.15)'
                        : 'rgba(37, 99, 235, 0.12)'
                    }`,
                  }}>
                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={
                        approval.risk === 'high' ? '#ef4444' : approval.risk === 'medium' ? '#f59e0b' : '#2563eb'
                      } strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      </svg>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: 'var(--t-text)',
                        letterSpacing: '-0.01em', flex: 1,
                      }}>
                        {approval.agent} — {approval.title}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                        padding: '2px 6px', borderRadius: 5,
                        background: approval.risk === 'high'
                          ? 'rgba(239, 68, 68, 0.1)'
                          : approval.risk === 'medium'
                          ? 'rgba(245, 158, 11, 0.1)'
                          : 'rgba(37, 99, 235, 0.1)',
                        color: approval.risk === 'high'
                          ? '#ef4444'
                          : approval.risk === 'medium'
                          ? '#f59e0b'
                          : '#2563eb',
                        letterSpacing: '0.03em',
                      }}>
                        {approval.risk}
                      </span>
                    </div>

                    {/* Description */}
                    <div style={{
                      fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.5,
                      marginBottom: approval.command ? 6 : 8,
                    }}>
                      {approval.description}
                    </div>

                    {/* Command preview */}
                    {approval.command && (
                      <div style={{
                        padding: '6px 8px', borderRadius: 8,
                        background: 'var(--t-code-bg)',
                        fontFamily: 'SF Mono, Menlo, monospace',
                        fontSize: 10, color: 'var(--t-text)',
                        marginBottom: 8, whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all', lineHeight: 1.4,
                      }}>
                        $ {approval.command}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => handleApprovalResolve(approval.id, 'approve')}
                        disabled={resolvingId === approval.id}
                        style={{
                          flex: 1, padding: '7px 0', borderRadius: 10, border: 'none',
                          background: '#22c55e', color: '#fff',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          opacity: resolvingId === approval.id ? 0.5 : 1,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {resolvingId === approval.id ? 'Resolving...' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprovalResolve(approval.id, 'reject')}
                        disabled={resolvingId === approval.id}
                        style={{
                          flex: 1, padding: '7px 0', borderRadius: 10,
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                          background: 'rgba(239, 68, 68, 0.06)',
                          color: '#ef4444',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          opacity: resolvingId === approval.id ? 0.5 : 1,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

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
                    <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', lineHeight: 1.4 }}>
                      Creates a GitHub issue, assigns an agent, generates a plan for your review, then executes.
                    </div>
                  </button>

                  {/* Task button */}
                  <button
                    type="button"
                    onClick={() => { setMode('task'); setTimeout(() => inputRef.current?.focus(), 50); }}
                    style={{
                      flex: 1, padding: '12px 14px', borderRadius: 12,
                      border: '1px solid var(--t-divider)',
                      background: 'var(--t-hover)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 120ms, border-color 120ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--t-panel-hover)';
                      e.currentTarget.style.borderColor = 'var(--t-divider-strong)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--t-hover)';
                      e.currentTarget.style.borderColor = 'var(--t-divider)';
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block' }}>
                        <polyline points="22 12 16 12 14 15 10 9 8 12 2 12"/>
                      </svg>
                      Task
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', lineHeight: 1.4 }}>
                      Quick chat with your main agent. Conversation stays right here — doesn&apos;t touch the main chat.
                    </div>
                  </button>
                </div>
                {/* Context-aware suggestions */}
                {suggestions.length > 0 && (
                  <div style={{
                    marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                      color: 'var(--t-text-muted)', letterSpacing: '0.05em', padding: '0 2px',
                    }}>
                      Suggested
                    </div>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setMode('task');
                          setTargetAgent(s.agent);
                          setInput(s.action);
                          setTimeout(() => inputRef.current?.focus(), 50);
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '8px 10px', borderRadius: 10, textAlign: 'left',
                          border: `1px solid ${
                            s.priority === 'critical' ? 'rgba(239, 68, 68, 0.15)'
                            : s.priority === 'warn' ? 'rgba(245, 158, 11, 0.12)'
                            : 'var(--t-divider)'
                          }`,
                          background: s.priority === 'critical' ? 'rgba(239, 68, 68, 0.04)'
                            : s.priority === 'warn' ? 'rgba(245, 158, 11, 0.04)'
                            : 'var(--t-hover)',
                          cursor: 'pointer',
                          transition: 'background 120ms',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = s.priority === 'critical' ? 'rgba(239, 68, 68, 0.08)' : s.priority === 'warn' ? 'rgba(245, 158, 11, 0.08)' : 'var(--t-panel-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = s.priority === 'critical' ? 'rgba(239, 68, 68, 0.04)' : s.priority === 'warn' ? 'rgba(245, 158, 11, 0.04)' : 'var(--t-hover)'; }}
                      >
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: s.priority === 'critical' ? '#ef4444'
                            : s.priority === 'warn' ? '#f59e0b' : 'var(--t-text-muted)',
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 11, color: 'var(--t-text)', lineHeight: 1.4,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {s.text}
                          </div>
                          <div style={{
                            fontSize: 9, color: 'var(--t-text-muted)', marginTop: 1,
                          }}>
                            → {s.agent.name}
                          </div>
                        </div>
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      </button>
                    ))}
                  </div>
                )}

                {/* Test approval trigger */}
                {approvals.length === 0 && (
                  <button
                    type="button"
                    onClick={handleTestApproval}
                    style={{
                      marginTop: 8, padding: '6px 0', borderRadius: 8,
                      border: '1px dashed var(--t-divider)',
                      background: 'transparent', color: 'var(--t-text-muted)',
                      fontSize: 10, fontWeight: 500, cursor: 'pointer',
                      letterSpacing: '-0.01em',
                      transition: 'color 120ms, border-color 120ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--t-text-secondary)';
                      e.currentTarget.style.borderColor = 'var(--t-divider-strong)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--t-text-muted)';
                      e.currentTarget.style.borderColor = 'var(--t-divider)';
                    }}
                  >
                    Simulate approval request
                  </button>
                )}
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
                      fontSize: 11, color: 'var(--t-text-muted)', fontWeight: 500,
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
                        border: '1px solid var(--t-input-border)',
                        background: 'var(--t-input-bg)',
                        fontSize: 13, color: 'var(--t-text)', resize: 'none',
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
                    marginBottom: 12, fontSize: 12, color: 'var(--t-text)',
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
                            fontSize: 12, color: si === currentStepIdx ? 'var(--t-text)' : 'var(--t-text-secondary)',
                            fontWeight: si === currentStepIdx ? 600 : 400,
                          }}>
                            {step.label}
                          </span>
                          {step.key === 'creating' && workflow.repo && si <= currentStepIdx && (
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)', marginLeft: 'auto' }}>{workflow.repo}</span>
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
                      background: 'var(--t-hover)', border: '1px solid var(--t-divider)',
                      fontSize: 11, color: 'var(--t-text)', lineHeight: 1.6, marginBottom: 10,
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
                        border: '1px solid var(--t-btn-secondary-border)', background: 'var(--t-btn-secondary-bg)',
                        color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
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
                      <div style={{ fontSize: 11, color: 'var(--t-text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
                        Quick chat with your main agent.<br/>
                        The main chat panel stays untouched.
                      </div>
                      <button type="button" onClick={() => setMode('pick')} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 500, marginTop: 4,
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
                          : 'var(--t-panel-translucent)',
                        border: msg.role === 'user'
                          ? '1px solid rgba(37, 99, 235, 0.15)'
                          : '1px solid var(--t-divider)',
                        fontSize: 12,
                        color: 'var(--t-text)',
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
                      background: 'var(--t-panel-translucent)',
                      border: '1px solid var(--t-divider)',
                      display: 'flex', gap: 4, alignItems: 'center',
                    }}>
                      {[0, 1, 2].map((i) => (
                        <div key={i} style={{
                          width: 5, height: 5, borderRadius: '50%',
                          background: 'var(--t-text-muted)',
                          animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                        }} />
                      ))}
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                {/* Compose bar with agent picker */}
                <div style={{
                  padding: '8px 12px 12px',
                  borderTop: '1px solid var(--t-divider-subtle)',
                  flexShrink: 0,
                }}>
                  {/* Agent picker row */}
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <button
                      type="button"
                      onClick={() => setAgentPickerOpen(v => !v)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '4px 8px', borderRadius: 8,
                        border: '1px solid var(--t-divider)',
                        background: 'var(--t-panel-translucent)',
                        cursor: 'pointer', fontSize: 11, fontWeight: 600,
                        color: targetAgent.color, letterSpacing: '-0.01em',
                        transition: 'background 120ms',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-panel-translucent)'; }}
                    >
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: targetAgent.color, display: 'block', flexShrink: 0,
                      }} />
                      {targetAgent.name}
                      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.5" strokeLinecap="round" style={{
                          display: 'block', transition: 'transform 200ms',
                          transform: agentPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        }}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </button>

                    {/* Dropdown */}
                    {agentPickerOpen && (
                      <div style={{
                        position: 'absolute', bottom: '100%', left: 0,
                        marginBottom: 4, minWidth: 160,
                        borderRadius: 12, padding: 4,
                        background: 'var(--t-panel-translucent)',
                        backdropFilter: 'blur(40px) saturate(180%)',
                        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                        border: '1px solid var(--t-panel-border)',
                        boxShadow: 'var(--t-panel-shadow)',
                        zIndex: 10,
                      }}>
                        {AGENTS.map((agent) => (
                          <button
                            key={agent.key}
                            type="button"
                            onClick={() => {
                              setTargetAgent(agent);
                              setAgentPickerOpen(false);
                              // Clear chat when switching agents
                              setChatMessages([]);
                              setWaitingForReply(false);
                              if (pollRef.current) clearInterval(pollRef.current);
                              sendTimestampRef.current = 0;
                              seenAssistantIdsRef.current.clear();
                            }}
                            style={{
                              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 10px', borderRadius: 8,
                              border: 'none', cursor: 'pointer', textAlign: 'left',
                              background: targetAgent.key === agent.key ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                              transition: 'background 100ms',
                            }}
                            onMouseEnter={(e) => {
                              if (targetAgent.key !== agent.key) e.currentTarget.style.background = 'var(--t-hover)';
                            }}
                            onMouseLeave={(e) => {
                              if (targetAgent.key !== agent.key) e.currentTarget.style.background = 'transparent';
                            }}
                          >
                            <span style={{
                              width: 8, height: 8, borderRadius: '50%',
                              background: agent.color, display: 'block', flexShrink: 0,
                            }} />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: agent.color }}>{agent.name}</div>
                              <div style={{ fontSize: 9, color: 'var(--t-text-muted)', fontFamily: 'SF Mono, Menlo, monospace' }}>
                                {agent.key}
                              </div>
                            </div>
                            {targetAgent.key === agent.key && (
                              <div style={{ marginLeft: 'auto', color: '#2563eb' }}>
                                <CheckIcon />
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ position: 'relative' }}>
                    <textarea
                      ref={mode === 'task' ? inputRef : undefined}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTaskSend(); }
                      }}
                      placeholder={waitingForReply ? `${targetAgent.name} is thinking...` : `Message ${targetAgent.name}...`}
                      disabled={waitingForReply}
                      rows={1}
                      style={{
                        width: '100%', minHeight: 36, maxHeight: 80,
                        padding: '8px 76px 8px 12px', borderRadius: 12,
                        border: '1px solid var(--t-input-border)',
                        background: waitingForReply ? 'var(--t-hover)' : 'var(--t-input-bg)',
                        fontSize: 12, color: 'var(--t-text)', resize: 'none',
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
          background: input.trim() ? 'rgba(37, 99, 235, 0.1)' : 'var(--t-hover)',
          color: enhancing ? '#93c5fd' : input.trim() ? '#2563eb' : 'var(--t-text-faint)',
          cursor: input.trim() && !enhancing ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 120ms, color 120ms',
          animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
        }}>
        <SparklesIcon />
      </button>
      <button type="button" onClick={onSubmit} disabled={!input.trim()} style={{
        width: sendSz, height: sendSz, borderRadius: 8, border: 'none',
        background: input.trim() ? '#2563eb' : 'var(--t-divider)',
        color: input.trim() ? '#fff' : 'var(--t-text-faint)',
        cursor: input.trim() ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 120ms',
      }}>
        <SendIcon />
      </button>
    </div>
  );
}
