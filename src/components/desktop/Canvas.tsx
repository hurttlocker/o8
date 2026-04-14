'use client';

/**
 * Canvas — Bottom-half contextual workspace with tabs.
 *
 * Responds to selections from AgentPanel:
 *   - Issue selected → opens issue detail tab
 *   - Agent surface clicked → opens live transcript tab
 *   - File selected → opens file viewer tab
 *
 * Tabs persist — you can have multiple open and switch between them.
 * Each tab type renders its own content viewer.
 *
 * Q's spec: bottom half of center, tabbed, replaces modals for primary content.
 */

import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  Clipboard,
  Clock,
  FileText,
  GitCommit,
  Globe,
  Hexagon,
  Plus,
  Terminal,
  X,
} from './lucide-shims';
const AuditLogPanel = lazy(() => import('@/components/desktop/AuditLogPanel').then(m => ({ default: m.AuditLogPanel })));
const CommitViewer = lazy(() => import('@/components/desktop/CommitViewer').then(m => ({ default: m.CommitViewer })));
const FileViewer = lazy(() => import('@/components/desktop/FileViewer').then(m => ({ default: m.FileViewer })));
const IssueCreator = lazy(() => import('@/components/desktop/IssueCreator').then(m => ({ default: m.IssueCreator })));
const IssueViewer = lazy(() => import('@/components/desktop/IssueViewer').then(m => ({ default: m.IssueViewer })));
const PRViewer = lazy(() => import('@/components/desktop/PRViewer').then(m => ({ default: m.PRViewer })));
import {
  CanvasEmpty,
  CIViewer,
  DeployViewer,
  DiffViewer,
  GitLogViewer,
  ImagePreview,
  MermaidViewer,
  PortPreview,
  ReadmeViewer,
  TimelineExpanded,
  TranscriptViewer,
} from './canvas/index';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import type { CanvasRepoTaskLaunchRequest } from './canvas-utils';

export { type CanvasRepoTaskLaunchRequest } from './canvas-utils';

export type CanvasTabKind =
  | 'issue'
  | 'transcript'
  | 'file'
  | 'diff'
  | 'commit'
  | 'pr'
  | 'readme'
  | 'ci'
  | 'new-issue'
  | 'git-log'
  | 'image'
  | 'deploy'
  | 'welcome'
  | 'timeline'
  | 'audit-log'
  | 'mermaid'
  | 'preview';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  label: string;
  resourceId: string;
  meta?: Record<string, string>;
}

export interface CanvasProps {
  tabs: CanvasTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  selectedRepo?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  embedded?: boolean;
}

export const Canvas = memo(function Canvas({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  selectedRepo,
  onSelectCommit,
  onInjectChatContext,
  onLaunchWorkspaceTask,
  embedded,
}: CanvasProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const syncScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -160 : 160, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(syncScrollState);
    return () => cancelAnimationFrame(raf);
  }, [syncScrollState, tabs.length]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--t-bg-subtle)',
        borderTop: '1px solid var(--t-divider)',
      }}
    >
      {tabs.length > 0 ? (
        <>
          {!embedded ? (
            <div
              style={{
                position: 'relative',
                height: 36,
                flexShrink: 0,
                background: 'var(--t-panel-translucent)',
                backdropFilter: 'blur(20px) saturate(1.6)',
                WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
                borderBottom: '1px solid var(--t-divider)',
              }}
            >
              {canScrollLeft ? (
                <div
                  onClick={() => scrollTabs('left')}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(to right, var(--t-panel-translucent) 60%, transparent)',
                    zIndex: 2,
                    cursor: 'pointer',
                    color: 'var(--t-text-secondary)',
                    transition: 'opacity 150ms ease',
                  }}
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </div>
              ) : null}

              {canScrollRight ? (
                <div
                  onClick={() => scrollTabs('right')}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(to left, var(--t-panel-translucent) 60%, transparent)',
                    zIndex: 2,
                    cursor: 'pointer',
                    color: 'var(--t-text-secondary)',
                    transition: 'opacity 150ms ease',
                  }}
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </div>
              ) : null}

              <div
                ref={tabScrollRef}
                onScroll={syncScrollState}
                onMouseEnter={syncScrollState}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0,
                  height: '100%',
                  paddingLeft: 8,
                  paddingRight: 8,
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  scrollbarWidth: 'none',
                }}
              >
                {tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <div
                      key={tab.id}
                      onClick={() => onSelectTab(tab.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        height: 28,
                        paddingTop: 0,
                        paddingRight: 10,
                        paddingBottom: 0,
                        paddingLeft: 10,
                        marginRight: 2,
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                        background: isActive ? 'var(--t-panel)' : 'transparent',
                        boxShadow: isActive ? 'var(--t-panel-shadow)' : 'none',
                        cursor: 'pointer',
                        transition: 'all 150ms ease',
                        flexShrink: 0,
                        letterSpacing: '-0.01em',
                        userSelect: 'none',
                      }}
                    >
                      <TabIcon kind={tab.kind} size={13} />
                      <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tab.label}
                      </span>
                      <div
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          marginLeft: 2,
                          color: 'var(--t-text-muted)',
                          cursor: 'pointer',
                          transition: 'all 100ms ease',
                        }}
                        onMouseEnter={(event) => {
                          event.currentTarget.style.background = 'var(--t-divider)';
                          event.currentTarget.style.color = '#ef4444';
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.background = 'transparent';
                          event.currentTarget.style.color = 'var(--t-text-muted)';
                        }}
                      >
                        <X size={11} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <AnimatePresence mode="wait" initial={false}>
          {activeTab ? (
            <motion.div
              key={activeTab.id}
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <TabContent
                tab={activeTab}
                selectedRepo={selectedRepo}
                onSelectCommit={onSelectCommit}
                onInjectChatContext={onInjectChatContext}
                onLaunchWorkspaceTask={onLaunchWorkspaceTask}
              />
            </motion.div>
          ) : (
            <motion.div
              key="canvas-empty"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <CanvasEmpty selectedRepo={selectedRepo} mode="idle" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});

function TabIcon({ kind, size = 14 }: { kind: CanvasTabKind; size?: number }) {
  switch (kind) {
    case 'issue':
      return <AlertCircle size={size} />;
    case 'transcript':
      return <Terminal size={size} />;
    case 'file':
      return <FileText size={size} />;
    case 'diff':
      return <GitCommit size={size} />;
    case 'commit':
      return <GitCommit size={size} />;
    case 'pr':
      return <GitCommit size={size} />;
    case 'readme':
      return <BookOpen size={size} />;
    case 'ci':
      return <AlertCircle size={size} />;
    case 'new-issue':
      return <Plus size={size} />;
    case 'git-log':
      return <GitCommit size={size} />;
    case 'image':
      return <FileText size={size} />;
    case 'deploy':
      return <Globe size={size} />;
    case 'welcome':
      return <BookOpen size={size} />;
    case 'timeline':
      return <Clock size={size} />;
    case 'audit-log':
      return <Clipboard size={size} />;
    case 'mermaid':
      return <Hexagon size={size} />;
    case 'preview':
      return <Globe size={size} />;
  }
}

const TabContent = memo(function TabContent({
  tab,
  selectedRepo,
  onSelectCommit,
  onInjectChatContext,
  onLaunchWorkspaceTask,
}: {
  tab: CanvasTab;
  selectedRepo?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
}) {
  return (
    <Suspense fallback={null}>
      {(() => {
        switch (tab.kind) {
          case 'issue':
            return (
              <IssueViewer
                issueNumber={parseInt(tab.resourceId, 10)}
                repo={tab.meta?.repo ?? selectedRepo ?? undefined}
                onLaunchWorkspaceTask={onLaunchWorkspaceTask}
              />
            );
          case 'transcript':
            return <TranscriptViewer sessionKey={tab.resourceId} />;
          case 'file':
            return <FileViewer filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
          case 'diff':
            return <DiffViewer />;
          case 'commit':
            return <CommitViewer commitHash={tab.resourceId} workspace={tab.meta?.workspace} />;
          case 'pr':
            return <PRViewer prNumber={parseInt(tab.resourceId, 10)} repo={tab.meta?.repo} onInjectChatContext={onInjectChatContext} />;
          case 'readme':
            return <ReadmeViewer workspace={tab.resourceId} />;
          case 'ci':
            return <CIViewer repo={tab.meta?.repo} initialRunId={tab.meta?.selectedRun ? parseInt(tab.meta.selectedRun, 10) : undefined} />;
          case 'new-issue':
            return <IssueCreator repo={tab.meta?.repo} />;
          case 'git-log':
            return <GitLogViewer workspace={tab.resourceId} onSelectCommit={onSelectCommit} />;
          case 'image':
            return <ImagePreview filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
          case 'deploy':
            return <DeployViewer project={tab.meta?.project} />;
          case 'welcome':
            return <CanvasEmpty selectedRepo={selectedRepo} mode="welcome" />;
          case 'timeline':
            return <TimelineExpanded />;
          case 'audit-log':
            return <AuditLogPanel />;
          case 'mermaid':
            return <MermaidViewer code={tab.resourceId} />;
          case 'preview':
            return <PortPreview url={tab.resourceId} port={parseInt(tab.meta?.port ?? '0', 10)} repo={tab.meta?.repo} />;
          default:
            return <CanvasEmpty selectedRepo={selectedRepo} mode="idle" />;
        }
      })()}
    </Suspense>
  );
});
