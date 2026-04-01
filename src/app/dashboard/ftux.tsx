import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export const FTUX_REVEAL_DURATION_MS = 5200;
export const FTUX_SPRING_TRANSITION = { type: 'spring' as const, stiffness: 400, damping: 30 };
export const FTUX_AGENT_PANEL_TARGET_WIDTH = 280;

export type GuidedDiscoveryPosition = 'top-left' | 'top-right' | 'top-center' | 'bottom-right' | 'bottom-left';

export interface GuidedDiscoveryAction {
  label: string;
  href?: string;
  onClick?: () => void;
  emphasized?: boolean;
}

function guidedDiscoveryPositionStyle(position: GuidedDiscoveryPosition): CSSProperties {
  switch (position) {
    case 'top-left':
      return { top: 16, left: 16 };
    case 'top-center':
      return { top: 16, left: '50%', transform: 'translateX(-50%)' };
    case 'bottom-right':
      return { right: 16, bottom: 16 };
    case 'bottom-left':
      return { left: 16, bottom: 16 };
    case 'top-right':
    default:
      return { top: 16, right: 16 };
  }
}

export function GuidedDiscoveryHalo({
  active,
  borderRadius = 18,
}: {
  active: boolean;
  borderRadius?: number;
}) {
  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{
            opacity: [0.42, 0.9, 0.52],
            scale: 1,
          }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{
            scale: FTUX_SPRING_TRANSITION,
            opacity: { duration: 1.8, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' },
          }}
          style={{
            position: 'absolute',
            inset: -6,
            borderRadius: borderRadius + 6,
            border: '1px solid color-mix(in srgb, var(--t-accent, #2563eb) 28%, transparent)',
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent) 0%, transparent 100%)',
            boxShadow: '0 0 0 1px color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent), 0 24px 56px color-mix(in srgb, var(--t-accent, #2563eb) 18%, transparent)',
            pointerEvents: 'none',
            zIndex: 8,
          }}
        />
      ) : null}
    </AnimatePresence>
  );
}

export function GuidedDiscoveryCoachmark({
  visible,
  position,
  title,
  body,
  actions = [],
  maxWidth = 320,
}: {
  visible: boolean;
  position: GuidedDiscoveryPosition;
  title: string;
  body: string;
  actions?: GuidedDiscoveryAction[];
  maxWidth?: number;
}) {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, y: position.startsWith('bottom') ? 16 : -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: position.startsWith('bottom') ? 16 : -12, scale: 0.96 }}
          transition={FTUX_SPRING_TRANSITION}
          style={{
            position: 'absolute',
            zIndex: 24,
            width: `min(${maxWidth}px, calc(100vw - 32px))`,
            padding: 14,
            borderRadius: 14,
            border: '1px solid color-mix(in srgb, var(--t-border-subtle, rgba(148,163,184,0.22)) 88%, white 12%)',
            background: 'color-mix(in srgb, var(--t-panel-translucent, rgba(255,255,255,0.9)) 92%, white 8%)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 18px 48px rgba(15, 23, 42, 0.14)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontFamily: 'system-ui',
            ...guidedDiscoveryPositionStyle(position),
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{
              fontSize: 10,
              lineHeight: 1.2,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--t-text-muted)',
            }}>
              Guided Discovery
            </span>
            <strong style={{
              fontSize: 14,
              lineHeight: 1.3,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--t-text)',
            }}>
              {title}
            </strong>
            <span style={{
              fontSize: 12,
              lineHeight: 1.55,
              letterSpacing: '-0.01em',
              color: 'var(--t-text-muted)',
            }}>
              {body}
            </span>
          </div>
          {actions.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {actions.map((action) => {
                const sharedStyle: CSSProperties = {
                  minHeight: 44,
                  padding: '0 14px',
                  borderRadius: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  border: `1px solid ${action.emphasized ? 'color-mix(in srgb, var(--t-accent, #2563eb) 24%, transparent)' : 'var(--t-border-subtle, rgba(148,163,184,0.22))'}`,
                  background: action.emphasized
                    ? 'color-mix(in srgb, var(--t-accent, #2563eb) 10%, transparent)'
                    : 'rgba(255,255,255,0.68)',
                  color: action.emphasized ? 'var(--t-text)' : 'var(--t-text-muted)',
                  fontFamily: 'system-ui',
                };

                return action.href ? (
                  <a
                    key={action.label}
                    href={action.href}
                    target={action.href.startsWith('http') ? '_blank' : undefined}
                    rel={action.href.startsWith('http') ? 'noreferrer' : undefined}
                    style={sharedStyle}
                  >
                    {action.label}
                  </a>
                ) : (
                  <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    style={sharedStyle}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
