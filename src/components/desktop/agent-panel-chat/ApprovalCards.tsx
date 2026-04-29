'use client';

import React, { memo, useState } from 'react';
import { ApprovalReviewScreenshot } from '@/components/desktop/ApprovalReviewScreenshot';
import { Sparkles } from '../lucide-shims';
import { THEME_ACCENT_SOFT, THEME_ACCENT, THEME_ACCENT_BORDER, THEME_BG_CARD } from './constants';
import { relativeTimeLabel } from './shared';
import type { SidebarApprovalCardProps, SidebarApproval } from './types';

// ── Gate Report Section ──

const GATE_CATEGORY_LABELS: Record<string, string> = {
  security: 'Security',
  budget: 'Budget',
  integrity: 'Integrity',
};

function GateReportSection({ approval }: { approval: SidebarApproval }) {
  const gate = approval.gateResult;
  const [expanded, setExpanded] = useState(false);

  if (!gate || gate.violations.length === 0) return null;
  const categories = ['security', 'budget', 'integrity'] as const;

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          position: 'relative',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 8,
          borderRadius: 8,
          border: '1px solid rgba(239, 68, 68, 0.12)',
          background: 'rgba(239, 68, 68, 0.04)',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 700,
          color: '#dc2626',
          letterSpacing: '0.02em',
        }}
      >
        <span style={{
          display: 'inline-block',
          width: 12,
          textAlign: 'center',
          transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          {'\u25B6'}
        </span>
        Gate Report: {gate.violations.filter((v) => v.severity === 'block').length} block, {gate.violations.filter((v) => v.severity === 'warn').length} warn
      </button>

      {expanded ? (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {categories.map((cat) => {
            const catViolations = gate.violations.filter((v) => v.category === cat);
            if (catViolations.length === 0) return (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, fontSize: 11 }}>
                <span style={{ color: '#16a34a', fontWeight: 800 }}>{'\u2713'}</span>
                <span style={{ fontWeight: 700, color: 'var(--t-text-secondary)' }}>{GATE_CATEGORY_LABELS[cat]}</span>
                <span style={{ color: 'var(--t-text-muted)', fontWeight: 600 }}>passed</span>
              </div>
            );

            return (
              <div key={cat} style={{ paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 2 }}>
                  <span style={{ color: '#dc2626', fontWeight: 800 }}>{'\u2717'}</span>
                  <span style={{ fontWeight: 700, color: 'var(--t-text-secondary)' }}>{GATE_CATEGORY_LABELS[cat]}</span>
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>{catViolations.length} violation{catViolations.length !== 1 ? 's' : ''}</span>
                </div>
                {catViolations.map((v, i) => (
                  <div key={i} style={{
                    fontSize: 10,
                    lineHeight: 1.4,
                    color: 'var(--t-text-muted)',
                    paddingLeft: 18,
                    marginTop: 1,
                  }}>
                    {v.label}{v.file ? ` (${v.file})` : ''}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Conflict Summary Section ──

const STRATEGY_OPTIONS = [
  { value: 'theirs', label: 'Theirs', desc: 'Keep branch changes' },
  { value: 'ours', label: 'Ours', desc: 'Keep base changes' },
  { value: 'manual', label: 'Manual', desc: 'Park for terminal fix' },
] as const;

function ConflictSection({
  approval,
  onResolve,
  resolvingId,
}: {
  approval: SidebarApproval;
  onResolve: (id: string, action: 'approve' | 'reject', strategy?: string) => void;
  resolvingId: string | null;
}) {
  const conflict = approval.conflictReport;
  const [selectedStrategy, setSelectedStrategy] = useState<string>('theirs');

  if (!conflict || conflict.files.length === 0) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        background: 'rgba(245, 158, 11, 0.06)',
        border: '1px solid rgba(245, 158, 11, 0.12)',
        marginBottom: 6,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginBottom: 4, letterSpacing: '0.02em' }}>
          {conflict.files.length} conflicting file{conflict.files.length !== 1 ? 's' : ''}
        </div>
        {conflict.files.slice(0, 8).map((file) => (
          <div key={file} style={{
            fontSize: 10,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            color: 'var(--t-text-muted)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {file}
          </div>
        ))}
        {conflict.files.length > 8 ? (
          <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 2 }}>
            +{conflict.files.length - 8} more
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        {STRATEGY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setSelectedStrategy(opt.value)}
            style={{
              flex: 1,
              minHeight: 44,
              paddingTop: 6,
              paddingRight: 4,
              paddingBottom: 6,
              paddingLeft: 4,
              borderRadius: 8,
              border: selectedStrategy === opt.value
                ? '1px solid rgba(37, 99, 235, 0.3)'
                : '1px solid var(--t-divider)',
              background: selectedStrategy === opt.value
                ? 'rgba(37, 99, 235, 0.08)'
                : 'transparent',
              cursor: 'pointer',
              fontSize: 10,
              fontWeight: 700,
              color: selectedStrategy === opt.value ? '#2563eb' : 'var(--t-text-muted)',
              textAlign: 'center',
              lineHeight: 1.3,
            }}
          >
            {opt.label}
            <div style={{
              fontSize: 9,
              fontWeight: 600,
              marginTop: 1,
              opacity: 0.7,
            }}>
              {opt.desc}
            </div>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => onResolve(approval.id, 'approve', selectedStrategy)}
          disabled={resolvingId === approval.id}
          style={{
            flex: 1,
            minHeight: 44,
            paddingTop: 7,
            paddingRight: 0,
            paddingBottom: 7,
            paddingLeft: 0,
            borderRadius: 8,
            border: 'none',
            background: '#16a34a',
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 800,
            cursor: 'pointer',
            opacity: resolvingId === approval.id ? 0.55 : 1,
          }}
        >
          {resolvingId === approval.id ? 'Working...' : `Merge (${STRATEGY_OPTIONS.find((o) => o.value === selectedStrategy)?.label})`}
        </button>
        <button
          type="button"
          onClick={() => onResolve(approval.id, 'reject')}
          disabled={resolvingId === approval.id}
          style={{
            minHeight: 44,
            minWidth: 44,
            paddingTop: 7,
            paddingRight: 12,
            paddingBottom: 7,
            paddingLeft: 12,
            borderRadius: 8,
            border: '1px solid rgba(239, 68, 68, 0.18)',
            background: 'rgba(239, 68, 68, 0.06)',
            color: '#dc2626',
            fontSize: 11,
            fontWeight: 800,
            cursor: 'pointer',
            opacity: resolvingId === approval.id ? 0.55 : 1,
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Main Card ──

export const SidebarApprovalCard = memo(function SidebarApprovalCard({
  approvals,
  resolvingId,
  onResolve,
}: SidebarApprovalCardProps) {
  if (approvals.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 10,
      paddingRight: 14,
      paddingBottom: 12,
      paddingLeft: 14,
      marginTop: 8,
      marginRight: 14,
      marginBottom: 10,
      marginLeft: 14,
      borderRadius: 18,
      background: 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)',
      border: `1px solid ${THEME_ACCENT_BORDER}`,
      boxShadow: 'var(--t-panel-shadow)',
      animation: 'sidebarApprovalIn 220ms ease-out',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 10,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          flexShrink: 0,
        }}>
          <Sparkles size={15} strokeWidth={2.2} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 800,
            color: 'var(--t-text-strong)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Approval Required
          </div>
          <div style={{
            marginTop: 2,
            fontSize: 11,
            color: 'var(--t-text-muted)',
            lineHeight: 1.4,
          }}>
            Review pending command or file actions for this session before the run continues.
          </div>
        </div>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 22,
          height: 22,
          paddingTop: 0,
          paddingRight: 7,
          paddingBottom: 0,
          paddingLeft: 7,
          borderRadius: 999,
          background: 'rgba(239, 68, 68, 0.12)',
          color: '#dc2626',
          fontSize: 11,
          fontWeight: 800,
        }}>
          {approvals.length}
        </span>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        {approvals.map((approval) => {
          const riskTone = approval.risk === 'high'
            ? { bg: 'rgba(239, 68, 68, 0.10)', fg: '#dc2626', border: 'rgba(239, 68, 68, 0.16)' }
            : approval.risk === 'medium'
              ? { bg: 'rgba(245, 158, 11, 0.10)', fg: '#b45309', border: 'rgba(245, 158, 11, 0.16)' }
              : { bg: 'rgba(37, 99, 235, 0.10)', fg: '#2563eb', border: 'rgba(37, 99, 235, 0.14)' };

          const hasConflict = approval.conflictReport && approval.conflictReport.files.length > 0;

          return (
            <div
              key={approval.id}
              style={{
                paddingTop: 12,
                paddingRight: 12,
                paddingBottom: 10,
                paddingLeft: 12,
                borderRadius: 14,
                background: THEME_BG_CARD,
                border: `1px solid ${riskTone.border}`,
                boxShadow: '0 10px 20px rgba(15, 23, 42, 0.08)',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}>
                <span style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--t-text)',
                  flex: 1,
                  letterSpacing: '-0.01em',
                }}>
                  {approval.agent} {'\u2022'} {approval.title}
                </span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--t-text-muted)',
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                }}>
                  {relativeTimeLabel(approval.createdAt)}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  paddingTop: 3,
                  paddingRight: 8,
                  paddingBottom: 3,
                  paddingLeft: 8,
                  borderRadius: 999,
                  background: riskTone.bg,
                  color: riskTone.fg,
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  {approval.risk}
                </span>
              </div>

              <div style={{
                fontSize: 12,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.55,
                marginBottom: 8,
              }}>
                {approval.description}
              </div>

              <ApprovalReviewScreenshot approval={approval} />

              <GateReportSection approval={approval} />

              {hasConflict ? (
                <ConflictSection approval={approval} onResolve={onResolve} resolvingId={resolvingId} />
              ) : (
                <>
                  {approval.command ? (
                    <div style={{
                      paddingTop: 8,
                      paddingRight: 10,
                      paddingBottom: 8,
                      paddingLeft: 10,
                      borderRadius: 10,
                      background: 'rgba(15, 23, 42, 0.96)',
                      color: '#e2e8f0',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      fontSize: 11,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      marginBottom: 10,
                    }}>
                      $ {approval.command}
                    </div>
                  ) : null}

                  <div style={{
                    display: 'flex',
                    gap: 8,
                  }}>
                    <button
                      type="button"
                      onClick={() => onResolve(approval.id, 'approve')}
                      disabled={resolvingId === approval.id}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        paddingTop: 8,
                        paddingRight: 0,
                        paddingBottom: 8,
                        paddingLeft: 0,
                        borderRadius: 10,
                        border: 'none',
                        background: '#16a34a',
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: 'pointer',
                        opacity: resolvingId === approval.id ? 0.55 : 1,
                        transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms cubic-bezier(0.22, 1, 0.36, 1)',
                        boxShadow: '0 10px 18px rgba(22, 163, 74, 0.18)',
                      }}
                      onMouseEnter={(e) => {
                        if (resolvingId === approval.id) return;
                        e.currentTarget.style.transform = 'translateY(-1px)';
                        e.currentTarget.style.boxShadow = '0 14px 22px rgba(22, 163, 74, 0.24)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 10px 18px rgba(22, 163, 74, 0.18)';
                      }}
                    >
                      {resolvingId === approval.id ? 'Working...' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolve(approval.id, 'reject')}
                      disabled={resolvingId === approval.id}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        paddingTop: 8,
                        paddingRight: 0,
                        paddingBottom: 8,
                        paddingLeft: 0,
                        borderRadius: 10,
                        border: '1px solid rgba(239, 68, 68, 0.18)',
                        background: 'rgba(239, 68, 68, 0.06)',
                        color: '#dc2626',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: 'pointer',
                        opacity: resolvingId === approval.id ? 0.55 : 1,
                        transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                      onMouseEnter={(e) => {
                        if (resolvingId === approval.id) return;
                        e.currentTarget.style.transform = 'translateY(-1px)';
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.10)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.06)';
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
