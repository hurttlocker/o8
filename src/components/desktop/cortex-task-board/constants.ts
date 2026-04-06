import type { CSSProperties } from 'react';
import type { BoardColumnId } from '@/lib/board/types';
import type { BoardComposerState } from './types';

export const COLUMN_ORDER: BoardColumnId[] = ['backlog', 'in_progress', 'review', 'trash'];
export const CARD_TRANSITION = 'all 180ms cubic-bezier(0.32, 0.72, 0, 1)';

export const DEFAULT_COMPOSER_STATE: BoardComposerState = {
  title: '',
  prompt: '',
  preferredRuntime: 'codex',
  baseBranch: 'main',
  issueId: '',
  prId: '',
  startInPlanMode: false,
};

export const sidePanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  paddingTop: 14,
  paddingRight: 14,
  paddingBottom: 14,
  paddingLeft: 14,
  borderRadius: 22,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  boxShadow: 'var(--shadow)',
  overflow: 'hidden',
};

export const columnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  borderRadius: 20,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
};

export const taskCardStyle: CSSProperties = {
  width: '100%',
  position: 'relative',
  borderRadius: 18,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  paddingTop: 14,
  paddingRight: 14,
  paddingBottom: 14,
  paddingLeft: 14,
  cursor: 'pointer',
  textAlign: 'left',
  transition: CARD_TRANSITION,
};

export const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
};

export const panelEyebrowStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#64748b',
};

export const panelTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: 4,
  fontSize: 15,
  fontWeight: 800,
  letterSpacing: '-0.02em',
  color: 'var(--text)',
};

export const columnCountStyle: CSSProperties = {
  minWidth: 26,
  height: 26,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  paddingTop: 0,
  paddingRight: 9,
  paddingBottom: 0,
  paddingLeft: 9,
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--text-secondary)',
};

export const columnIssueHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
  fontSize: 11,
  color: 'var(--text-secondary)',
  fontWeight: 600,
};

export const ghostButtonStyle: CSSProperties = {
  height: 28,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  paddingTop: 0,
  paddingRight: 10,
  paddingBottom: 0,
  paddingLeft: 10,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontWeight: 700,
};

export const columnEmptyStyle: CSSProperties = {
  paddingTop: 14,
  paddingRight: 12,
  paddingBottom: 14,
  paddingLeft: 12,
  borderRadius: 14,
  border: '1px dashed var(--border)',
  background: 'rgba(255,255,255,0.06)',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
};

export const secondaryButtonStyle: CSSProperties = {
  height: 38,
  borderRadius: 14,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  color: 'var(--text)',
  paddingTop: 0,
  paddingRight: 14,
  paddingBottom: 0,
  paddingLeft: 14,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  fontWeight: 700,
};

export const emptyStateStyle: CSSProperties = {
  minHeight: 180,
  borderRadius: 20,
  border: '1px dashed var(--border)',
  background: 'var(--panel)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  fontSize: 12,
  fontWeight: 600,
};

export const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingTop: 10,
  paddingRight: 12,
  paddingBottom: 10,
  paddingLeft: 12,
  borderRadius: 14,
  border: '1px solid rgba(239,68,68,0.22)',
  background: 'var(--red-soft)',
  color: 'var(--red)',
  fontSize: 12,
  fontWeight: 600,
};

export const closeButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  color: 'var(--text-secondary)',
  fontSize: 16,
  lineHeight: 1,
};

export const dependencyHandleStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: -8,
  transform: 'translateY(-50%)',
  width: 18,
  height: 40,
  borderRadius: 999,
  border: '1px solid var(--border)',
  boxShadow: '0 10px 24px rgba(15,23,42,0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'grab',
  zIndex: 3,
};

export const dependencyHandleDotsStyle: CSSProperties = {
  width: 4,
  height: 18,
  borderRadius: 999,
  background: 'currentColor',
  opacity: 0.82,
};

export const dependencyDeleteButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.24)',
  background: 'rgba(255,255,255,0.68)',
  backdropFilter: 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
  color: '#1d4ed8',
  boxShadow: '0 10px 24px rgba(15,23,42,0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};
