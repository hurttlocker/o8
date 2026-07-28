'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Check, Copy } from '../lucide-shims';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT_STRONG,
  THEME_DIVIDER,
  THEME_DIVIDER_SUBTLE,
  THEME_GLASS_MUTED,
  THEME_GLASS_MUTED_STRONG,
  THEME_PANEL,
  THEME_PANEL_BORDER,
  THEME_TEXT,
  THEME_TEXT_FAINT,
  THEME_TEXT_MUTED,
} from './theme';
import type { ToolDisplayInfo } from './types';

export function AnimatedCheck({ delay = 0 }: { delay?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: visible ? '#22c55e' : 'rgba(34,197,94,0.15)',
      transition: 'background 400ms cubic-bezier(0.34, 1.36, 0.64, 1), transform 400ms cubic-bezier(0.34, 1.36, 0.64, 1), opacity 400ms cubic-bezier(0.34, 1.36, 0.64, 1)',
      transform: visible ? 'scale(1)' : 'scale(0.5)',
      opacity: visible ? 1 : 0.3,
      flexShrink: 0,
    }}>
      <Check size={12} strokeWidth={3} color="#fff" style={{
        opacity: visible ? 1 : 0,
        transition: 'opacity 300ms cubic-bezier(0.22, 1, 0.36, 1)',
        transitionDelay: '100ms',
      }} />
    </span>
  );
}

export function GrayDot() {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: THEME_DIVIDER_SUBTLE,
      flexShrink: 0,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: THEME_TEXT_FAINT,
      }} />
    </span>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderRadius: 10,
      background: THEME_GLASS_MUTED,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      fontFamily: '"SF Mono", ui-monospace, monospace',
      fontSize: 12,
      color: THEME_TEXT,
      lineHeight: '18px',
    }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {command}
      </span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 6,
          border: 'none',
          background: copied ? 'rgba(34, 197, 94, 0.14)' : THEME_PANEL,
          color: copied ? '#22c55e' : THEME_TEXT_MUTED,
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {copied ? <Check size={14} strokeWidth={2.5} /> : <Copy size={14} strokeWidth={2} />}
      </button>
    </div>
  );
}

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} style={{
          width: i === current ? 18 : 6,
          height: 6,
          borderRadius: 999,
          background: i === current
            ? THEME_ACCENT
            : i < current ? THEME_ACCENT_SOFT_STRONG : THEME_DIVIDER,
          transition: 'background 300ms cubic-bezier(0.34, 1.36, 0.64, 1)',
        }} />
      ))}
    </div>
  );
}

export function GlassButton({
  label,
  onClick,
  variant = 'primary',
  icon,
  disabled,
  style: overrideStyle,
}: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  icon?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: variant === 'ghost' ? '8px 12px' : '12px 24px',
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'inherit',
    letterSpacing: '-0.01em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 200ms cubic-bezier(0.22, 1, 0.36, 1), color 200ms cubic-bezier(0.22, 1, 0.36, 1), border-color 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms cubic-bezier(0.22, 1, 0.36, 1)',
    border: 'none',
    opacity: disabled ? 0.5 : 1,
    ...(variant === 'primary' ? {
      background: `linear-gradient(180deg, #60a5fa 0%, ${THEME_ACCENT} 100%)`,
      color: '#fff',
      boxShadow: `0 12px 28px ${THEME_ACCENT_RING}, inset 0 1px 0 rgba(255,255,255,0.2)`,
    } : variant === 'secondary' ? {
      background: THEME_GLASS_MUTED_STRONG,
      color: THEME_TEXT,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      boxShadow: '0 10px 24px rgba(0,0,0,0.06)',
    } : {
      background: 'transparent',
      color: THEME_TEXT_MUTED,
    }),
    ...overrideStyle,
  };
  void THEME_ACCENT_BORDER;

  return (
    <button disabled={disabled} onClick={disabled ? undefined : onClick} style={base}>
      {icon}
      {label}
    </button>
  );
}

export function SetupWizardStepFrame({
  stepKey,
  direction,
  children,
}: {
  stepKey: string;
  direction: 'forward' | 'back';
  children: ReactNode;
}) {
  const [entering, setEntering] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 50);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div
      key={stepKey}
      style={{
        opacity: entering ? 0 : 1,
        transform: entering
          ? direction === 'forward'
            ? 'translateY(12px) scale(0.985)'
            : 'translateY(-12px) scale(0.985)'
          : 'translateY(0) scale(1)',
        transition: 'opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.34, 1.36, 0.64, 1)',
      }}
    >
      {children}
    </div>
  );
}

export function ToolRow({ tool, index }: { tool: ToolDisplayInfo; index: number }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 0',
    }}>
      {tool.detected ? <AnimatedCheck delay={index * 80} /> : <GrayDot />}
      <span style={{
        color: tool.detected ? THEME_TEXT : THEME_TEXT_MUTED,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
      }}>
        {tool.icon}
        {tool.name}
      </span>
      {tool.version && (
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: THEME_TEXT_MUTED,
          padding: '2px 6px',
          borderRadius: 999,
          background: THEME_DIVIDER_SUBTLE,
        }}>
          v{tool.version}
        </span>
      )}
      {tool.detail && (
        <span style={{
          fontSize: 11,
          color: THEME_TEXT_MUTED,
          marginLeft: 'auto',
        }}>
          {tool.detail}
        </span>
      )}
    </div>
  );
}
