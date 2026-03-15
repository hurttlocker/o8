'use client';

import { useState, useCallback } from 'react';
import { AgentPanel } from '@/components/desktop/AgentPanel';
import { DesktopChat } from '@/components/desktop/DesktopChat';

export default function DashboardPage() {
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(420);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();

  // ── Left drag handle ──
  const startLeftDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      setLeftWidth(Math.min(Math.max(startW + (ev.clientX - startX), 220), 500));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  // ── Right drag handle ──
  const startRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: MouseEvent) => {
      // Dragging left makes it wider (startX - ev.clientX)
      setRightWidth(Math.min(Math.max(startW + (startX - ev.clientX), 320), 600));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      background: '#eef1f6',
      color: '#1e293b',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ── Left: Agent Panel ── */}
      <div style={{
        width: leftWidth,
        flexShrink: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRight: '1px solid rgba(0,0,0,0.06)',
      }}>
        <AgentPanel onSelectSession={setActiveSessionKey} />
      </div>

      {/* ── Left drag handle ── */}
      <div
        onMouseDown={startLeftDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'rgba(0,0,0,0.08)',
          transition: 'background-color 150ms',
        }} />
      </div>

      {/* ── Center: Workspace ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        background: 'linear-gradient(180deg, #f0f4f8 0%, #e8edf4 100%)',
      }}>
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.12, color: '#94a3b8' }}>◇</div>
          <h1 style={{
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            marginBottom: 8,
            color: '#1e293b',
          }}>
            Workspace
          </h1>
          <p style={{
            fontSize: 14,
            color: '#94a3b8',
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
          }}>
            Editor, terminals, and diff views will live here.
          </p>
        </div>
      </div>

      {/* ── Right drag handle ── */}
      <div
        onMouseDown={startRightDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'rgba(0,0,0,0.08)',
          transition: 'background-color 150ms',
        }} />
      </div>

      {/* ── Right: Chat Sidebar ── */}
      <div style={{
        width: rightWidth,
        flexShrink: 0,
        height: '100vh',
        borderLeft: '1px solid rgba(0,0,0,0.06)',
      }}>
        <DesktopChat externalSessionKey={activeSessionKey} />
      </div>
    </div>
  );
}
