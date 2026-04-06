'use client';

import React, { memo } from 'react';
import { Sparkles } from 'lucide-react';
import { THEME_ACCENT_SOFT, THEME_ACCENT, THEME_ACCENT_BORDER, THEME_BG_CARD } from './constants';
import { relativeTimeLabel } from './shared';
import type { SidebarApprovalCardProps } from './types';

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
      padding: '10px 14px 12px',
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
          padding: '0 7px',
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

          return (
            <div
              key={approval.id}
              style={{
                padding: '12px 12px 10px',
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
                  padding: '3px 8px',
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
                marginBottom: approval.command ? 8 : 10,
              }}>
                {approval.description}
              </div>

              {approval.command ? (
                <div style={{
                  padding: '8px 10px',
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
                    padding: '8px 0',
                    borderRadius: 10,
                    border: 'none',
                    background: '#16a34a',
                    color: '#ffffff',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                  opacity: resolvingId === approval.id ? 0.55 : 1,
                  transition: 'transform 160ms ease, box-shadow 160ms ease',
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
                    padding: '8px 0',
                    borderRadius: 10,
                    border: '1px solid rgba(239, 68, 68, 0.18)',
                    background: 'rgba(239, 68, 68, 0.06)',
                    color: '#dc2626',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                    opacity: resolvingId === approval.id ? 0.55 : 1,
                    transition: 'transform 160ms ease, background 160ms ease',
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
            </div>
          );
        })}
      </div>
    </div>
  );
});
