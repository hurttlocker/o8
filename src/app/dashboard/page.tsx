'use client';

import { useState, useCallback, useRef } from 'react';
import { AgentPanel } from '@/components/desktop/AgentPanel';
import { DesktopChat } from '@/components/desktop/DesktopChat';
import { Canvas, CanvasTab } from '@/components/desktop/Canvas';

export default function DashboardPage() {
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(420);
  const [canvasHeight, setCanvasHeight] = useState(50); // percentage of center column
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();

  // ── Canvas tab state ──
  const [canvasTabs, setCanvasTabs] = useState<CanvasTab[]>([]);
  const [activeCanvasTabId, setActiveCanvasTabId] = useState<string | null>(null);

  const openCanvasTab = useCallback((tab: CanvasTab) => {
    setCanvasTabs((prev) => {
      // If tab with same id already exists, just activate it
      const existing = prev.find((t) => t.id === tab.id);
      if (existing) return prev;
      return [...prev, tab];
    });
    setActiveCanvasTabId(tab.id);
  }, []);

  const closeCanvasTab = useCallback((tabId: string) => {
    setCanvasTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If we closed the active tab, activate the last remaining tab
      setActiveCanvasTabId((currentActive) => {
        if (currentActive === tabId) {
          return next.length > 0 ? next[next.length - 1].id : null;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

  // ── Routing callbacks for AgentPanel ──
  const handleSelectSession = useCallback((sessionKey: string) => {
    // Open transcript in canvas AND switch chat
    setActiveSessionKey(sessionKey);
    openCanvasTab({
      id: `transcript:${sessionKey}`,
      kind: 'transcript',
      label: sessionKey.split(':').pop() || 'Session',
      resourceId: sessionKey,
    });
  }, [openCanvasTab]);

  const handleSelectIssue = useCallback((issueNumber: number) => {
    openCanvasTab({
      id: `issue:${issueNumber}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
    });
  }, [openCanvasTab]);

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

  // ── Canvas vertical drag handle ──
  const centerRef = useRef<HTMLDivElement>(null);
  const startCanvasDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = canvasHeight;
    const onMove = (ev: MouseEvent) => {
      if (!centerRef.current) return;
      const rect = centerRef.current.getBoundingClientRect();
      const totalH = rect.height;
      const deltaY = startY - ev.clientY; // dragging up = bigger canvas
      const deltaPct = (deltaY / totalH) * 100;
      setCanvasHeight(Math.min(Math.max(startH + deltaPct, 20), 80));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [canvasHeight]);

  // ── Right drag handle ──
  const startRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: MouseEvent) => {
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
        <AgentPanel
          onSelectSession={handleSelectSession}
          onSelectIssue={handleSelectIssue}
        />
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

      {/* ── Center: Workspace (top) + Canvas (bottom) ── */}
      <div ref={centerRef} style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Top — workspace placeholder (future: editor, terminals) */}
        <div style={{
          flex: canvasTabs.length > 0 ? `0 0 ${100 - canvasHeight}%` : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
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

        {/* Vertical drag handle between workspace and canvas */}
        {canvasTabs.length > 0 && (
          <div
            onMouseDown={startCanvasDrag}
            style={{
              height: 6,
              cursor: 'row-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              zIndex: 10,
              background: 'rgba(0,0,0,0.02)',
            }}
          >
            <div style={{
              width: 40,
              height: 3,
              borderRadius: 2,
              backgroundColor: 'rgba(0,0,0,0.08)',
              transition: 'background-color 150ms',
            }} />
          </div>
        )}

        {/* Bottom — Canvas (tabs + contextual content) */}
        {canvasTabs.length > 0 && (
          <div style={{ flex: `0 0 ${canvasHeight}%`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Canvas
              tabs={canvasTabs}
              activeTabId={activeCanvasTabId}
              onSelectTab={setActiveCanvasTabId}
              onCloseTab={closeCanvasTab}
            />
          </div>
        )}
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
        <DesktopChat
          externalSessionKey={activeSessionKey}
          onOpenDiff={() => {
            openCanvasTab({
              id: 'diff:workspace',
              kind: 'diff',
              label: 'Diff',
              resourceId: 'workspace',
            });
          }}
        />
      </div>
    </div>
  );
}
