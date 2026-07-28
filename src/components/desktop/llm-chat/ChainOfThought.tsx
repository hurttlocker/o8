import { memo, useState } from 'react';
import { Brain, Check, ChevronRight, Eye, FileText, Search, Zap } from '../lucide-shims';

import { THEME_ACCENT, THEME_ACCENT_BORDER, THEME_ACCENT_SOFT, THEME_BG_CARD, type ThinkingStep, type ToolCallInfo } from './shared';

function ChainOfThoughtBase({
  steps,
  thinking,
  durationMs,
  isLive = false,
}: {
  steps: ThinkingStep[];
  thinking?: string;
  durationMs?: number;
  isLive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0 && !thinking) return null;

  const completedCount = steps.filter((step) => step.status === 'complete').length;
  const activeStep = steps.find((step) => step.status === 'active');
  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div style={{ maxWidth: '90%', marginBottom: 6, animation: 'llmFadeIn 200ms ease-out' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingRight: 10,
          paddingBottom: 6,
          paddingLeft: 10,
          background: isLive ? THEME_ACCENT_SOFT : THEME_BG_CARD,
          border: `1px solid ${isLive ? THEME_ACCENT_BORDER : 'var(--t-panel-border)'}`,
          borderRadius: 9,
          cursor: 'pointer',
          width: 'auto',
          minWidth: 0,
          textAlign: 'left',
          transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            flexShrink: 0,
            color: isLive ? THEME_ACCENT : 'var(--t-text-muted)',
            ...(isLive ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}),
          }}
        >
          <Brain size={11} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 500, fontStyle: 'italic', color: 'var(--t-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isLive && activeStep ? activeStep.label : `Thought for ${durationSec ? `${durationSec}s` : `${completedCount} step${completedCount !== 1 ? 's' : ''}`}`}
          </div>
        </div>
        <ChevronRight size={12} style={{ color: 'var(--t-text-muted)', transform: expanded ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)', flexShrink: 0 }} />
      </button>
      {expanded ? (
        <div style={{ marginTop: 4, marginLeft: 23, paddingLeft: 12, borderLeft: '2px solid var(--t-divider)', animation: 'llmFadeIn 200ms ease-out' }}>
          {steps.map((step, index) => {
            const StepIcon = step.type === 'search' ? Search : step.type === 'reading' ? FileText : step.type === 'analyzing' ? Zap : step.type === 'tool' ? Eye : Brain;
            return (
              <div key={`${step.label}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 8, paddingBottom: 8, animation: `llmFadeIn 200ms ease-out ${index * 50}ms both` }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 1,
                    background: step.status === 'complete' ? '#dcfce7' : step.status === 'active' ? '#dbeafe' : '#f1f5f9',
                    border: `1px solid ${step.status === 'complete' ? '#86efac' : step.status === 'active' ? '#93c5fd' : '#e2e8f0'}`,
                  }}
                >
                  {step.status === 'complete' ? (
                    <Check size={10} style={{ color: '#16a34a' }} />
                  ) : step.status === 'active' ? (
                    <StepIcon size={10} style={{ color: '#3b82f6', animation: 'llmDot 1.4s ease-in-out infinite' }} />
                  ) : (
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#cbd5e1' }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: step.status === 'active' ? '#1e40af' : '#374151' }}>{step.label}</div>
                  {step.description ? <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, lineHeight: '1.4' }}>{step.description}</div> : null}
                </div>
              </div>
            );
          })}
          {thinking ? <ThinkingText text={thinking} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export const ChainOfThought = memo(ChainOfThoughtBase);

function ThinkingText({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div style={{ marginTop: 4, marginBottom: 4 }}>
      <button
        type="button"
        onClick={() => setShowRaw((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: '#94a3b8', fontSize: 11, cursor: 'pointer', paddingTop: 4, paddingRight: 0, paddingBottom: 4, paddingLeft: 0 }}
      >
        <ChevronRight size={10} style={{ transform: showRaw ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' }} />
        View raw thinking
      </button>
      {showRaw ? (
        <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ marginTop: 4, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, background: '#f8fafc', borderRadius: 6, fontSize: 11, color: '#64748b', lineHeight: '1.6', fontFamily: 'ui-monospace, monospace', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', animation: 'llmFadeIn 200ms ease-out' }}>
          {text}
        </div>
      ) : null}
    </div>
  );
}

export function StreamingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 16, paddingBottom: 8 }}>
      {[0, 1, 2].map((index) => (
        <span key={index} style={{ width: 6, height: 6, borderRadius: '50%', background: '#94a3b8', animation: `llmDot 1.4s ease-in-out ${index * 0.2}s infinite` }} />
      ))}
    </div>
  );
}

function LiveToolCallsBase({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '90%' }}>
      {toolCalls.map((toolCall, index) => (
        <div
          key={`${toolCall.name}-${index}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, animation: 'llmFadeIn 200ms ease-out' }}
        >
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: toolCall.status === 'done' ? '#10b981' : '#3b82f6', ...(toolCall.status !== 'done' ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}) }} />
          <span style={{ color: '#64748b', fontWeight: 500 }}>
            {toolCall.name === 'search_web' ? 'Searching' : toolCall.name === 'read_file' ? 'Reading' : toolCall.name === 'list_files' ? 'Listing' : toolCall.name === 'search_code' ? 'Searching code' : toolCall.name}
          </span>
          <span style={{ color: '#94a3b8' }}>{toolCall.args?.query ? `"${toolCall.args.query}"` : toolCall.args?.path ? String(toolCall.args.path) : ''}</span>
          {toolCall.status === 'done' ? <Check size={12} style={{ color: '#10b981' }} /> : null}
        </div>
      ))}
    </div>
  );
}

export const LiveToolCalls = memo(LiveToolCallsBase);
