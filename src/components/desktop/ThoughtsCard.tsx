'use client';

/**
 * ThoughtsCard — Floating glass command surface.
 *
 * Not a page — an overlay. Draggable, sits on top of everything.
 * User types intent ("I need X on Y repo") and the card orchestrates
 * the full workflow: create issue → assign agent → review plan → execute.
 *
 * The card shows each workflow step as it progresses.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ── Types ──

type WorkflowStep = 'idle' | 'thinking' | 'creating' | 'assigning' | 'planning' | 'reviewing' | 'executing' | 'done';

interface WorkflowState {
  step: WorkflowStep;
  issue?: string;
  repo?: string;
  agent?: string;
  plan?: string;
  summary?: string;
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

// ── Step Indicator ──

function StepIndicator({ step, currentStep }: { step: WorkflowStep; currentStep: WorkflowStep }) {
  const si = stepIndex(step);
  const ci = stepIndex(currentStep);
  const isDone = ci > si;
  const isActive = ci === si;

  return isDone ? (
    <div style={{ color: '#22c55e' }}><CheckIcon /></div>
  ) : isActive ? (
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

export function ThoughtsCard({ open, onClose }: ThoughtsCardProps) {
  const [input, setInput] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowState>({ step: 'idle' });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [initialized, setInitialized] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
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

  // Focus input when un-minimized
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, minimized]);

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

  // ── Submit thought ──

  const handleSubmit = useCallback(() => {
    if (!input.trim()) return;
    const thought = input.trim();
    setInput('');

    // Simulate workflow progression
    setWorkflow({ step: 'thinking', summary: thought });

    const advance = (step: WorkflowStep, extras: Partial<WorkflowState>, delay: number) => {
      setTimeout(() => setWorkflow(prev => ({ ...prev, step, ...extras })), delay);
    };

    // Demo flow — in real implementation, each step calls real APIs
    advance('creating', { repo: 'hurttlocker/cortex-ide' }, 1500);
    advance('assigning', { issue: '#117', agent: 'Niot' }, 3000);
    advance('planning', {}, 4500);
    advance('reviewing', { plan: 'Agent will analyze the codebase, create isolated worktree, implement changes, and open PR for review.' }, 6500);
  }, [input]);

  const handleApprove = useCallback(() => {
    setWorkflow(prev => ({ ...prev, step: 'executing' }));
    setTimeout(() => setWorkflow(prev => ({ ...prev, step: 'done' })), 3000);
  }, []);

  const handleReset = useCallback(() => {
    setWorkflow({ step: 'idle' });
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  if (!open) return null;

  const isActive = workflow.step !== 'idle';
  const currentStepIdx = stepIndex(workflow.step);

  return (
    <>
      {/* Spin animation */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div
        ref={cardRef}
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: minimized ? 220 : 400,
          zIndex: 9999,
          borderRadius: minimized ? 12 : 18,
          background: 'rgba(255, 255, 255, 0.78)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid rgba(255, 255, 255, 0.45)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04)',
          overflow: 'hidden',
          transition: 'width 250ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 250ms',
          fontFamily: '-apple-system, system-ui, BlinkMacSystemFont, sans-serif',
        }}
      >
        {/* Header — drag handle */}
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
          }}
        >
          <GripIcon />
          <span style={{
            fontSize: 12, fontWeight: 700, color: '#111827',
            letterSpacing: '-0.01em', flex: 1,
          }}>
            Thoughts
          </span>
          {isActive && !minimized && (
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

        {/* Body — hidden when minimized */}
        {!minimized && (
          <div style={{ padding: '12px 14px 14px' }}>
            {/* Input area */}
            {workflow.step === 'idle' && (
              <div style={{ position: 'relative' }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder="What do you need? Describe the task, bug, or feature..."
                  style={{
                    width: '100%',
                    minHeight: 72,
                    maxHeight: 160,
                    padding: '10px 42px 10px 12px',
                    borderRadius: 12,
                    border: '1px solid rgba(0,0,0,0.08)',
                    background: 'rgba(255,255,255,0.6)',
                    fontSize: 13,
                    color: '#111827',
                    resize: 'vertical',
                    outline: 'none',
                    fontFamily: 'inherit',
                    lineHeight: 1.5,
                    letterSpacing: '-0.01em',
                    boxSizing: 'border-box',
                  }}
                />
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!input.trim()}
                  style={{
                    position: 'absolute',
                    right: 8,
                    bottom: 8,
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: 'none',
                    background: input.trim() ? '#2563eb' : 'rgba(0,0,0,0.06)',
                    color: input.trim() ? '#fff' : '#b0b8c4',
                    cursor: input.trim() ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 120ms',
                  }}
                >
                  <SendIcon />
                </button>
              </div>
            )}

            {/* Workflow summary */}
            {isActive && workflow.summary && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 10,
                background: 'rgba(37, 99, 235, 0.04)',
                border: '1px solid rgba(37, 99, 235, 0.08)',
                marginBottom: 12,
                fontSize: 12,
                color: '#374151',
                lineHeight: 1.5,
                fontStyle: 'italic',
              }}>
                &ldquo;{workflow.summary}&rdquo;
              </div>
            )}

            {/* Workflow steps */}
            {isActive && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {STEPS.map((step, i) => {
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
                      {/* Contextual detail */}
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
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(0,0,0,0.02)',
                  border: '1px solid rgba(0,0,0,0.06)',
                  fontSize: 11,
                  color: '#374151',
                  lineHeight: 1.6,
                  marginBottom: 10,
                }}>
                  {workflow.plan}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={handleApprove} style={{
                    flex: 1, padding: '8px 0', borderRadius: 10, border: 'none',
                    background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600,
                    cursor: 'pointer',
                  }}>
                    Approve
                  </button>
                  <button type="button" style={{
                    flex: 1, padding: '8px 0', borderRadius: 10,
                    border: '1px solid rgba(0,0,0,0.1)', background: '#fff',
                    color: '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>
                    Edit Plan
                  </button>
                </div>
              </div>
            )}

            {/* Done state */}
            {workflow.step === 'done' && (
              <div style={{ marginTop: 12 }}>
                <button type="button" onClick={handleReset} style={{
                  width: '100%', padding: '8px 0', borderRadius: 10, border: 'none',
                  background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer',
                }}>
                  New Thought
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
