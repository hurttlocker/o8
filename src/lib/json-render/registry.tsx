/**
 * json-render React registry for Cortex IDE mobile
 *
 * Maps catalog component types to actual React rendering.
 * Styled to match the existing mobile design language (red accent, Apple-inspired).
 */
// @ts-nocheck — json-render v0.14 types are complex; runtime works, TS inference needs upstream fixes
'use client';

import { defineRegistry } from '@json-render/react';
import { catalog } from './catalog';
import React, { type CSSProperties } from 'react';

// ── Styles ──

const cardBase: CSSProperties = {
  background: '#ffffff',
  borderRadius: 16,
  padding: '16px 18px',
  marginBottom: 10,
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  border: '1px solid #e5e7eb',
};

const severityBorder: Record<string, string> = {
  info: '#3b82f6',
  warning: '#f59e0b',
  critical: '#ef4444',
};

const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: '#dbeafe', text: '#1e40af', dot: '#3b82f6' },
  success: { bg: '#dcfce7', text: '#166534', dot: '#22c55e' },
  error: { bg: '#fef2f2', text: '#991b1b', dot: '#ef4444' },
  waiting: { bg: '#fefce8', text: '#854d0e', dot: '#eab308' },
};

const trendArrows: Record<string, string> = { up: '↑', down: '↓', flat: '→' };

// ── Registry ──

export const { registry } = defineRegistry(catalog, {
  actions: {
    approve: async (ctx) => { console.log('[json-render] approve', ctx); },
    reject: async (ctx) => { console.log('[json-render] reject', ctx); },
    select_option: async (ctx) => { console.log('[json-render] select_option', ctx); },
    navigate: async (ctx) => { console.log('[json-render] navigate', ctx); },
    dismiss: async (ctx) => { console.log('[json-render] dismiss', ctx); },
  },
  components: {
    ApprovalCard: ({ props, children }) => (
      <div
        style={{
          ...cardBase,
          borderLeft: `4px solid ${severityBorder[props.severity] ?? severityBorder.info}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6b7280' }}>
            {props.agent} · Approval
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 99,
              background: props.severity === 'critical' ? '#fef2f2' : props.severity === 'warning' ? '#fefce8' : '#eff6ff',
              color: props.severity === 'critical' ? '#dc2626' : props.severity === 'warning' ? '#d97706' : '#2563eb',
            }}
          >
            {props.severity}
          </span>
        </div>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px', color: '#0f172a' }}>{props.title}</h3>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: '#475569', margin: '0 0 12px' }}>{props.description}</p>
        {props.metadata ? (
          <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 10, marginBottom: 10 }}>
            {Object.entries(props.metadata).map(([key, val]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                <span style={{ color: '#94a3b8' }}>{key}</span>
                <span style={{ color: '#0f172a', fontWeight: 500 }}>{val}</span>
              </div>
            ))}
          </div>
        ) : null}
        {children as React.ReactNode}
      </div>
    ),

    StatusCard: ({ props, children }) => {
      const c = statusColors[props.status] ?? statusColors.waiting;
      return (
        <div style={{ ...cardBase, background: c.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: c.text }}>{props.title}</span>
          </div>
          <p style={{ fontSize: 14, color: c.text, margin: 0, opacity: 0.85 }}>{props.message}</p>
          {typeof props.progress === 'number' ? (
            <div style={{ marginTop: 10, background: 'rgba(0,0,0,0.1)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
              <div style={{ width: `${props.progress}%`, height: '100%', background: c.dot, borderRadius: 4, transition: 'width 0.3s' }} />
            </div>
          ) : null}
          {children as React.ReactNode}
        </div>
      );
    },

    Metric: ({ props }) => (
      <div style={{ ...cardBase, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '14px 16px' }}>
        <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500, marginBottom: 4 }}>{props.label}</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{props.value}</span>
          {props.trend ? (
            <span style={{ fontSize: 14, color: props.trend === 'up' ? '#22c55e' : props.trend === 'down' ? '#ef4444' : '#94a3b8' }}>
              {trendArrows[props.trend]}
            </span>
          ) : null}
        </div>
      </div>
    ),

    OptionList: ({ props, emit }) => (
      <div style={cardBase}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px', color: '#0f172a' }}>{props.question}</h3>
        {props.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => emit('press')}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '12px 14px',
              marginBottom: 6,
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              background: '#fafafa',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <strong style={{ color: '#0f172a' }}>{opt.label}</strong>
            {opt.description ? <span style={{ display: 'block', fontSize: 13, color: '#64748b', marginTop: 2 }}>{opt.description}</span> : null}
          </button>
        ))}
      </div>
    ),

    TextBlock: ({ props }) => (
      <div
        style={{
          ...cardBase,
          background: props.variant === 'highlight' ? '#fffbeb' : props.variant === 'muted' ? '#f8fafc' : '#ffffff',
          fontSize: 14,
          lineHeight: 1.6,
          color: props.variant === 'muted' ? '#64748b' : '#0f172a',
        }}
      >
        {props.content}
      </div>
    ),

    CodeBlock: ({ props }) => (
      <div style={{ ...cardBase, background: '#1e293b', padding: '12px 14px' }}>
        {props.filename ? (
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, fontFamily: 'monospace' }}>{props.filename}</div>
        ) : null}
        <pre style={{ margin: 0, fontSize: 13, color: '#e2e8f0', fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {props.code}
        </pre>
      </div>
    ),

    ButtonRow: ({ props, children }) => (
      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: props.align === 'center' ? 'center' : props.align === 'right' ? 'flex-end' : props.align === 'spread' ? 'space-between' : 'flex-start',
          padding: '4px 0',
        }}
      >
        {children as React.ReactNode}
      </div>
    ),

    Button: ({ props, emit }) => {
      const variants: Record<string, CSSProperties> = {
        primary: { background: '#ef4444', color: '#fff', border: 'none', boxShadow: '0 2px 8px rgba(239,68,68,0.3)' },
        secondary: { background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0' },
        danger: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' },
        ghost: { background: 'transparent', color: '#64748b', border: 'none' },
      };
      const v = variants[props.variant ?? 'primary'] ?? variants.primary;
      return (
        <button
          type="button"
          onClick={() => emit('press')}
          disabled={props.disabled}
          style={{
            ...v,
            padding: '10px 18px',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 600,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
            flex: 1,
          }}
        >
          {props.label}
        </button>
      );
    },
  },
});
