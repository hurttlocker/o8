'use client';

import Image from 'next/image';
import Link from 'next/link';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileDiff,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Menu,
  Monitor,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import type { ReviewChangedFile, RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileActionRequest,
  MobileActionResponse,
  MobileHistoryResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';

function pickCurrentSession(snapshot: MobileInboxSnapshot) {
  return snapshot.sessions.find((session) => session.isCurrentSession)
    ?? snapshot.sessions.find((session) => session.sessionKey === snapshot.primarySessionKey)
    ?? snapshot.sessions[0];
}

function roleLabel(role: MobileTranscriptEntry['role'], agentName?: string) {
  switch (role) {
    case 'assistant':
      return agentName ?? 'Mister';
    case 'user':
      return 'You';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Message';
  }
}

function compactLine(text: string | null | undefined, fallback: string, max = 84) {
  const value = text?.trim() || fallback;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function diffLineTone(line: string) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

function contextPressureTone(usedPercent: number) {
  if (usedPercent >= 85) return 'critical';
  if (usedPercent >= 75) return 'high';
  if (usedPercent >= 65) return 'watch';
  return 'calm';
}

function contextTrendLabel(trend?: 'falling' | 'stable' | 'rising') {
  switch (trend) {
    case 'rising':
      return 'Rising';
    case 'falling':
      return 'Falling';
    case 'stable':
    default:
      return 'Stable';
  }
}

function ownedLifecycleTone(availability?: string, lastOutcome?: string) {
  if (lastOutcome === 'failed') return 'critical' as const;
  if (availability === 'running') return 'high' as const;
  if (lastOutcome === 'interrupted') return 'watch' as const;
  return 'calm' as const;
}

function ownedLifecycleLabel(availability?: string) {
  switch (availability) {
    case 'awaiting-thread':
      return 'Awaiting thread';
    case 'ready-for-resume':
      return 'Ready for resume';
    case 'running':
      return 'Running';
    default:
      return 'Idle';
  }
}

function ownedOutcomeLabel(lastOutcome?: string) {
  switch (lastOutcome) {
    case 'finished':
      return 'Finished';
    case 'interrupted':
      return 'Interrupted';
    case 'failed':
      return 'Failed';
    default:
      return 'No outcome yet';
  }
}

function ownedReviewDispositionLabel(disposition?: RuntimeReviewPacket['reviewDisposition']) {
  return disposition === 'resolved' ? 'Resolved' : 'Watching';
}

function ownedReviewDispositionTone(disposition?: RuntimeReviewPacket['reviewDisposition']) {
  return disposition === 'resolved' ? 'calm' : 'watch';
}

function threadLaneLabel(session: MobileInboxSnapshot['sessions'][number]) {
  if (session.isCurrentSession) return 'Mister';
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned') return 'Codex';
  return session.runtime === 'openclaw' ? 'OpenClaw' : 'Session';
}

function threadLaneState(session: MobileInboxSnapshot['sessions'][number]) {
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned') {
    const availability = session.runtimeSurface?.lifecycle?.availability;
    if (availability === 'running') return 'live';
    if (session.runtimeSurface?.capabilities.sendInput) return 'chat';
    return 'watch';
  }

  if (session.isCurrentSession) return 'live';
  return session.status;
}

function buildOwnedCorrectionDraft(packet: RuntimeReviewPacket) {
  const lines = [
    'Continue from the current owned session state. Use the packet evidence below and make the smallest correct next move.',
  ];

  if (packet.lastRun) {
    lines.push(`Last run: ${packet.lastRun.mode} • ${packet.lastRun.outcome}.`);
  }
  if (packet.lastRun?.assistantSummary) {
    lines.push(`Assistant summary: ${packet.lastRun.assistantSummary}`);
  }
  if (packet.lastRun?.commands[0]) {
    const command = packet.lastRun.commands[0];
    lines.push(`Command evidence: ${command.command} (${command.status}${command.exitCode != null ? `, exit ${command.exitCode}` : ''}).`);
  }
  if (packet.changedFiles.length) {
    lines.push(`Current repo delta: ${packet.changedFiles.slice(0, 5).map((file) => file.path).join(', ')}.`);
  } else {
    lines.push('Current repo delta is clean, so prefer a bounded verification or summary step over a broad rewrite.');
  }

  lines.push('Inspect the exact diff context, correct only the smallest failing or incomplete piece, and then summarize what changed and what still needs review.');
  return lines.join('\n');
}

const mobileClockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

function mediaHref(path: string, download = false) {
  const params = new URLSearchParams({ path });
  if (download) {
    params.set('download', '1');
  }
  return `/api/mobile/media?${params.toString()}`;
}

function isImageMedia(media: MobileTranscriptMedia) {
  return media.kind === 'image';
}

type DraftAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  content: string;
  previewUrl: string;
};

type PendingOwnedTurn = {
  id: string;
  prompt: string;
  createdAt: number;
  timestampLabel: string;
};

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error(`Unable to read ${file.name}`));
    };
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function pushPlainInline(nodes: ReactNode[], text: string, keyPrefix: string) {
  if (!text) {
    return;
  }

  text.split('\n').forEach((part, index) => {
    if (index > 0) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
    if (part) {
      nodes.push(<Fragment key={`${keyPrefix}-text-${index}`}>{part}</Fragment>);
    }
  });
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*][\s\S]*?\*\*|`[^`]+`|\*[^*][\s\S]*?\*)/g;
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(tokenRegex)) {
    const token = match[0];
    const start = match.index ?? 0;
    pushPlainInline(nodes, text.slice(lastIndex, start), `${keyPrefix}-${matchIndex}-plain`);

    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-${matchIndex}-strong`}>
          {renderInlineMarkdown(token.slice(2, -2), `${keyPrefix}-${matchIndex}-strong-inner`)}
        </strong>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-${matchIndex}-em`}>
          {renderInlineMarkdown(token.slice(1, -1), `${keyPrefix}-${matchIndex}-em-inner`)}
        </em>,
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-${matchIndex}-code`}>{token.slice(1, -1)}</code>);
    } else {
      pushPlainInline(nodes, token, `${keyPrefix}-${matchIndex}-fallback`);
    }

    lastIndex = start + token.length;
    matchIndex += 1;
  }

  pushPlainInline(nodes, text.slice(lastIndex), `${keyPrefix}-tail`);
  return nodes;
}

function renderMessageBody(text: string, keyPrefix: string) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let paragraphLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    const paragraph = paragraphLines.join('\n').trim();
    if (paragraph) {
      blocks.push(
        <p key={`${keyPrefix}-p-${blocks.length}`} className="remodex-rich-paragraph">
          {renderInlineMarkdown(paragraph, `${keyPrefix}-p-${blocks.length}`)}
        </p>,
      );
    }
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) {
      listType = null;
      listItems = [];
      return;
    }

    const ListTag = listType;
    blocks.push(
      <ListTag key={`${keyPrefix}-${listType}-${blocks.length}`} className="remodex-rich-list">
        {listItems.map((item, index) => (
          <li key={`${keyPrefix}-${listType}-${blocks.length}-${index}`}>
            {renderInlineMarkdown(item, `${keyPrefix}-${listType}-${blocks.length}-${index}`)}
          </li>
        ))}
      </ListTag>,
    );

    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push(
        <p
          key={`${keyPrefix}-h-${blocks.length}`}
          className={`remodex-rich-heading remodex-rich-heading-${Math.min(headingMatch[1].length, 3)}`}
        >
          {renderInlineMarkdown(headingMatch[2], `${keyPrefix}-h-${blocks.length}`)}
        </p>,
      );
      continue;
    }

    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') {
        flushList();
      }
      listType = 'ol';
      listItems.push(orderedMatch[1]);
      continue;
    }

    if (unorderedMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') {
        flushList();
      }
      listType = 'ul';
      listItems.push(unorderedMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();

  return <div className="remodex-rich-text">{blocks}</div>;
}

async function readJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export function MobileRemoteShell({
  initialSnapshot,
  initialTranscript,
  initialReviewFile,
  initialOwnedReviewPacket,
}: {
  initialSnapshot: MobileInboxSnapshot;
  initialTranscript?: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  initialReviewFile?: MobileReviewFileResponse['file'] | null;
  initialOwnedReviewPacket?: RuntimeReviewPacket | null;
}) {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => pickCurrentSession(initialSnapshot)?.id ?? '');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [surfaceNote, setSurfaceNote] = useState<string | null>(null);
  const [historyBySession, setHistoryBySession] = useState<Record<string, MobileTranscriptEntry[]>>(() => (
    initialTranscript?.sessionKey ? { [initialTranscript.sessionKey]: initialTranscript.transcript } : {}
  ));
  const [historyGroupsBySession, setHistoryGroupsBySession] = useState<Record<string, MobileRuntimeTailGroup[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | null>>({});
  const [reviewPacketBySession, setReviewPacketBySession] = useState<Record<string, RuntimeReviewPacket>>(() => (
    initialOwnedReviewPacket ? { [initialOwnedReviewPacket.surfaceId]: initialOwnedReviewPacket } : {}
  ));
  const [reviewPacketLoadingBySession, setReviewPacketLoadingBySession] = useState<Record<string, boolean>>({});
  const [reviewPacketErrorBySession, setReviewPacketErrorBySession] = useState<Record<string, string | null>>({});
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  const [actionStateBySession, setActionStateBySession] = useState<Record<string, 'idle' | 'steering' | 'stopping' | 'reviewing'>>({});
  const [actionNoteBySession, setActionNoteBySession] = useState<Record<string, string | null>>({});
  const [draftAttachmentsBySession, setDraftAttachmentsBySession] = useState<Record<string, DraftAttachment[]>>({});
  const [pendingOwnedTurnBySession, setPendingOwnedTurnBySession] = useState<Record<string, PendingOwnedTurn>>({});
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(() => (
    initialReviewFile?.path ?? initialOwnedReviewPacket?.changedFiles[0]?.path ?? initialSnapshot.review?.changedFiles[0]?.path ?? null
  ));
  const [reviewFileByPath, setReviewFileByPath] = useState<Record<string, MobileReviewFileResponse['file']>>(() => (
    initialReviewFile ? { [initialReviewFile.path]: initialReviewFile } : {}
  ));
  const [reviewFileLoadingPath, setReviewFileLoadingPath] = useState<string | null>(null);
  const [reviewFileError, setReviewFileError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [surfaceRefreshing, setSurfaceRefreshing] = useState(false);
  const [expandedMedia, setExpandedMedia] = useState<MobileTranscriptMedia | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [viewportTopOffset, setViewportTopOffset] = useState(0);
  const [composeFocused, setComposeFocused] = useState(false);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const scrollStopTimerRef = useRef<number | null>(null);
  const headerRevealTimerRef = useRef<number | null>(null);
  const initialBottomPinBySessionRef = useRef<Record<string, boolean>>({});
  const stickToBottomRef = useRef(true);

  const refreshInbox = useCallback(async () => {
    const response = await fetch('/api/mobile/inbox', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
    // Only update state if snapshot meaningfully changed — prevents cascade re-renders
    setSnapshot((prev) => {
      // Compare session count + statuses + context usage as a fast equality check
      // Round usedPercent to nearest integer — fractional changes shouldn't trigger re-renders
      const prevKey = prev.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
      const nextKey = nextSnapshot.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
      if (prevKey === nextKey && prev.summary.alerts === nextSnapshot.summary.alerts) {
        return prev; // same reference — React skips re-render
      }
      return nextSnapshot;
    });
    setRefreshError(null);
    return nextSnapshot;
  }, []);

  const isWindowNearBottom = useCallback((threshold = 160) => {
    if (typeof window === 'undefined') {
      return true;
    }

    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportBottom = scrollTop + window.innerHeight;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    return documentHeight - viewportBottom <= threshold;
  }, []);

  const scrollToLatestMessage = useCallback((force = false) => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!force && !stickToBottomRef.current) {
      return;
    }

    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const readViewportTopOffset = () => {
      const nextOffset = typeof window === 'undefined'
        ? 0
        : Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0));
      setViewportTopOffset((current) => (current === nextOffset ? current : nextOffset));
    };

    readViewportTopOffset();
    window.visualViewport?.addEventListener('resize', readViewportTopOffset);
    window.visualViewport?.addEventListener('scroll', readViewportTopOffset);
    window.addEventListener('orientationchange', readViewportTopOffset);

    return () => {
      window.visualViewport?.removeEventListener('resize', readViewportTopOffset);
      window.visualViewport?.removeEventListener('scroll', readViewportTopOffset);
      window.removeEventListener('orientationchange', readViewportTopOffset);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function refreshLiveInbox() {
      try {
        const nextSnapshot = await fetch('/api/mobile/inbox', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return (await response.json()) as MobileInboxSnapshot;
        });
        if (!active) return;
        setSnapshot(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh mobile inbox');
      }
    }

    void refreshLiveInbox();
    const timer = window.setInterval(() => {
      void refreshLiveInbox();
    }, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    const clearHeaderReveal = () => {
      if (headerRevealTimerRef.current) {
        window.clearTimeout(headerRevealTimerRef.current);
        headerRevealTimerRef.current = null;
      }
    };

    const scheduleHeaderReveal = (delayMs = 700) => {
      clearHeaderReveal();
      headerRevealTimerRef.current = window.setTimeout(() => {
        setHeaderVisible(true);
        headerRevealTimerRef.current = null;
      }, delayMs);
    };

    const readScrollY = () => window.scrollY || document.documentElement.scrollTop || 0;

    const markScrollSettled = () => {
      if (scrollStopTimerRef.current) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
      scrollStopTimerRef.current = window.setTimeout(() => {
        setIsScrolling(false);
        if (readScrollY() <= 12) {
          clearHeaderReveal();
          setHeaderVisible(true);
        }
        scrollStopTimerRef.current = null;
      }, 150);
    };

    const updateScrollY = () => {
      frame = 0;
      const nextScrollY = readScrollY();
      stickToBottomRef.current = isWindowNearBottom();
      setScrollY((current) => (Math.abs(current - nextScrollY) > 1 ? nextScrollY : current));
    };

    const handleScroll = () => {
      const nextScrollY = readScrollY();
      stickToBottomRef.current = isWindowNearBottom();
      setScrollY((current) => (Math.abs(current - nextScrollY) > 1 ? nextScrollY : current));
      setIsScrolling(true);
      if (nextScrollY > 12) {
        setHeaderVisible(false);
        scheduleHeaderReveal(700);
      } else {
        clearHeaderReveal();
        setHeaderVisible(true);
      }
      markScrollSettled();
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateScrollY);
    };

    const handleResize = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateScrollY);
    };

    updateScrollY();
    if (readScrollY() <= 12) {
      setHeaderVisible(true);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      if (scrollStopTimerRef.current) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
      clearHeaderReveal();
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, [isWindowNearBottom]);

  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && snapshot.sessions.some((session) => session.id === currentId)) {
        return currentId;
      }
      return pickCurrentSession(snapshot)?.id ?? '';
    });
  }, [snapshot]);

  const selectedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === selectedId) ?? pickCurrentSession(snapshot),
    [selectedId, snapshot],
  );

  const selectedSessionKey = selectedSession?.sessionKey;
  const isOpenClawSession = selectedSession?.runtime === 'openclaw';
  const isOwnedCodexSession = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'owned';
  const selectedReviewPacket = selectedSessionKey && isOwnedCodexSession ? reviewPacketBySession[selectedSessionKey] ?? null : null;
  const selectedReviewPacketLoading = selectedSessionKey && isOwnedCodexSession ? reviewPacketLoadingBySession[selectedSessionKey] ?? false : false;
  const selectedReviewPacketError = selectedSessionKey && isOwnedCodexSession ? reviewPacketErrorBySession[selectedSessionKey] ?? null : null;
  const stickyReviewFilesRef = useRef<ReviewChangedFile[]>([]);
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const lastAssistantCountRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // Seed with all current IDs so initial render doesn't animate everything
    if (!seenMessageIdsRef.current) {
      seenMessageIdsRef.current = new Set(transcriptEntries.map((e) => e.id));
    }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reviewFiles = useMemo(() => {
    const next = isOwnedCodexSession
      ? selectedReviewPacket?.changedFiles ?? []
      : snapshot.review?.changedFiles ?? [];
    // Keep last known non-empty file list if a poll temporarily returns empty
    // (e.g., during compaction, git lock, or slow endpoint)
    if (next.length) {
      stickyReviewFilesRef.current = next;
      return next;
    }
    return stickyReviewFilesRef.current;
  }, [isOwnedCodexSession, selectedReviewPacket, snapshot.review?.changedFiles]);

  const loadHistory = useCallback(async (sessionKey: string, force = false) => {
    if (!force && historyBySession[sessionKey]?.length) {
      return historyBySession[sessionKey];
    }

    setHistoryLoading((current) => ({ ...current, [sessionKey]: true }));
    try {
      const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=18`, {
        cache: 'no-store',
      });
      const payload = await readJson<MobileHistoryResponse>(response);
      // Diff-and-patch: only update state if transcript actually changed.
      // Prevents React re-render flash when polling returns identical data.
      setHistoryBySession((current) => {
        const prev = current[sessionKey] ?? [];
        const next = payload.transcript;
        // Fast path: same length + same last ID = no change
        if (
          prev.length === next.length
          && prev.length > 0
          && prev[prev.length - 1]?.id === next[next.length - 1]?.id
          // Also check the last message text in case of streaming/edit updates
          && prev[prev.length - 1]?.text === next[next.length - 1]?.text
        ) {
          return current; // return same reference — React skips re-render
        }
        // Merge: keep optimistic entries that haven't been replaced yet,
        // then append only genuinely new server entries
        const existingIds = new Set(prev.filter((e) => !e.id.startsWith('optimistic-')).map((e) => e.id));
        const newServerEntries = next.filter((e) => !existingIds.has(e.id));
        if (newServerEntries.length === 0 && prev.length >= next.length) {
          // Server returned subset of what we have (optimistic entries still pending)
          return current;
        }
        return { ...current, [sessionKey]: next };
      });
      setHistoryGroupsBySession((current) => {
        const prev = current[sessionKey] ?? [];
        const next = payload.groups ?? [];
        if (prev.length === next.length && prev.length > 0 && prev[prev.length - 1]?.id === next[next.length - 1]?.id) {
          return current;
        }
        return { ...current, [sessionKey]: next };
      });
      setHistoryError((current) => ({ ...current, [sessionKey]: null }));
      return payload.transcript;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load session history';
      setHistoryError((current) => ({ ...current, [sessionKey]: message }));
      throw error;
    } finally {
      setHistoryLoading((current) => ({ ...current, [sessionKey]: false }));
    }
  }, [historyBySession]);

  const loadOwnedReviewPacket = useCallback(async (sessionKey: string, force = false) => {
    if (!sessionKey.startsWith('codex-owned:')) {
      return null;
    }
    if (!force && reviewPacketBySession[sessionKey]) {
      return reviewPacketBySession[sessionKey];
    }

    setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: true }));
    try {
      const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(sessionKey)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<RuntimeReviewPacket>(response);
      setReviewPacketBySession((current) => ({ ...current, [sessionKey]: payload }));
      setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: null }));
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the owned review packet.';
      setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: message }));
      throw error;
    } finally {
      setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: false }));
    }
  }, [reviewPacketBySession]);

  const loadReviewFile = useCallback(async (reviewPath: string, force = false) => {
    if (!force && reviewFileByPath[reviewPath]) {
      setReviewFileError(null);
      return reviewFileByPath[reviewPath];
    }

    setReviewFileLoadingPath(reviewPath);
    setReviewFileError(null);
    try {
      const response = await fetch(`/api/mobile/review-file?path=${encodeURIComponent(reviewPath)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<MobileReviewFileResponse>(response);
      setReviewFileByPath((current) => ({ ...current, [reviewPath]: payload.file }));
      return payload.file;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the per-file review preview.';
      setReviewFileError(message);
      throw error;
    } finally {
      setReviewFileLoadingPath((current) => (current === reviewPath ? null : current));
    }
  }, [reviewFileByPath]);

  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }

    if (!historyBySession[selectedSessionKey]?.length && !historyLoading[selectedSessionKey]) {
      void loadHistory(selectedSessionKey).catch(() => undefined);
    }
  }, [historyBySession, historyLoading, loadHistory, selectedSessionKey]);

  useEffect(() => {
    if (!selectedSessionKey || !selectedSessionKey.startsWith('codex-owned:')) {
      return;
    }

    if (!reviewPacketBySession[selectedSessionKey] && !reviewPacketLoadingBySession[selectedSessionKey]) {
      void loadOwnedReviewPacket(selectedSessionKey).catch(() => undefined);
    }
  }, [loadOwnedReviewPacket, reviewPacketBySession, reviewPacketLoadingBySession, selectedSessionKey]);

  useEffect(() => {
    if (!reviewFiles.length) {
      setSelectedReviewFilePath(null);
      setReviewFileError(null);
      return;
    }

    if (selectedReviewFilePath && reviewFiles.some((file) => file.path === selectedReviewFilePath)) {
      return;
    }

    const nextPath = reviewFiles[0]?.path ?? null;
    setSelectedReviewFilePath(nextPath);
    if (nextPath) {
      void loadReviewFile(nextPath).catch(() => undefined);
    }
  }, [loadReviewFile, reviewFiles, selectedReviewFilePath]);

  // Adaptive polling: fast when active, slow when idle, paused when tab hidden
  const documentVisibleRef = useRef(true);
  useEffect(() => {
    const handler = () => {
      documentVisibleRef.current = document.visibilityState === 'visible';
      // Immediately refresh when tab becomes visible again
      if (documentVisibleRef.current && selectedSessionKey) {
        void loadHistory(selectedSessionKey, true).catch(() => undefined);
        void refreshInbox().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [loadHistory, refreshInbox, selectedSessionKey]);

  useEffect(() => {
    if (!selectedSessionKey) {
      return;
    }

    const ownedActive = selectedSessionKey.startsWith('codex-owned:')
      && (
        selectedSession?.runtimeSurface?.lifecycle?.availability === 'running'
        || Boolean(pendingOwnedTurnBySession[selectedSessionKey])
        || actionStateBySession[selectedSessionKey] === 'steering'
      );
    const isActive = ownedActive || selectedSession?.status === 'running' || waitingForResponse;
    const intervalMs = ownedActive
      ? 1500
      : selectedSessionKey.startsWith('codex-owned:')
        ? 4000
        : isActive
          ? 2500
          : 20000; // idle: 20s instead of 10s — less aggressive

    const timer = window.setInterval(() => {
      // Skip polling when tab is hidden — no point updating invisible UI
      if (!documentVisibleRef.current) return;

      void loadHistory(selectedSessionKey, true).catch(() => undefined);
      // Only refresh inbox when something is actually happening
      if (isActive) {
        void refreshInbox().catch(() => undefined);
      }
      if (selectedSessionKey.startsWith('codex-owned:')) {
        void loadOwnedReviewPacket(selectedSessionKey, true).catch(() => undefined);
      }
      // Only poll review files when diff view is actually open AND session is active
      if (selectedReviewFilePath && diffOpen && (isActive || selectedSessionKey.startsWith('codex-owned:'))) {
        void loadReviewFile(selectedReviewFilePath, true).catch(() => undefined);
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [actionStateBySession, diffOpen, loadHistory, loadOwnedReviewPacket, loadReviewFile, pendingOwnedTurnBySession, refreshInbox, selectedReviewFilePath, selectedSession?.runtimeSurface?.lifecycle?.availability, selectedSession?.status, selectedSessionKey, waitingForResponse]);

  const transcriptEntries = selectedSessionKey ? historyBySession[selectedSessionKey] ?? [] : [];
  const transcriptGroups = selectedSessionKey ? historyGroupsBySession[selectedSessionKey] ?? [] : [];
  const transcriptLoading = selectedSessionKey ? historyLoading[selectedSessionKey] ?? false : false;
  const transcriptError = selectedSessionKey ? historyError[selectedSessionKey] ?? null : null;
  const transcriptDraft = selectedSessionKey ? draftBySession[selectedSessionKey] ?? '' : '';
  const transcriptAttachments = selectedSessionKey ? draftAttachmentsBySession[selectedSessionKey] ?? [] : [];
  const pendingOwnedTurn = selectedSessionKey ? pendingOwnedTurnBySession[selectedSessionKey] ?? null : null;
  const transcriptActionState = selectedSessionKey ? actionStateBySession[selectedSessionKey] ?? 'idle' : 'idle';

  // Clear typing indicator only when a new ASSISTANT message appears
  const assistantCount = transcriptEntries.filter((e) => e.role === 'assistant').length;
  useEffect(() => {
    if (waitingForResponse && assistantCount > lastAssistantCountRef.current) {
      setWaitingForResponse(false);
    }
  }, [waitingForResponse, assistantCount]);
  const transcriptActionNote = selectedSessionKey ? actionNoteBySession[selectedSessionKey] ?? null : null;
  const latestTranscriptMarker = transcriptEntries[transcriptEntries.length - 1]?.id ?? 'empty';
  const scrollMarker = pendingOwnedTurn ? `${latestTranscriptMarker}:${pendingOwnedTurn.id}` : latestTranscriptMarker;
  const selectedReviewFile = selectedReviewFilePath ? reviewFileByPath[selectedReviewFilePath] : undefined;
  const threadSwitcher = useMemo(() => {
    const candidates = [
      selectedSession,
      ...snapshot.sessions.filter((session) => session.isCurrentSession),
      ...snapshot.sessions.filter((session) => session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned'),
    ].filter(Boolean) as MobileInboxSnapshot['sessions'];

    const seen = new Set<string>();
    const deduped = [] as MobileInboxSnapshot['sessions'];
    for (const session of candidates) {
      if (seen.has(session.id)) {
        continue;
      }
      seen.add(session.id);
      deduped.push(session);
      if (deduped.length >= 4) {
        break;
      }
    }
    return deduped;
  }, [selectedSession, snapshot.sessions]);
  const selectedReviewFileIndex = selectedReviewFilePath
    ? reviewFiles.findIndex((file) => file.path === selectedReviewFilePath)
    : -1;
  const selectedReviewFilePosition = selectedReviewFileIndex >= 0 ? selectedReviewFileIndex + 1 : 0;
  const hasPrevReviewFile = selectedReviewFileIndex > 0;
  const hasNextReviewFile = selectedReviewFileIndex >= 0 && selectedReviewFileIndex < reviewFiles.length - 1;
  const totalAdditions = reviewFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = reviewFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const focusedAdditions = selectedReviewFile?.additions ?? totalAdditions;
  const focusedDeletions = selectedReviewFile?.deletions ?? totalDeletions;
  const sessionSwitcher = snapshot.sessions.slice(0, 5);
  const activeTitle = compactLine(
    isOwnedCodexSession
      ? selectedReviewPacket?.title ?? selectedSession?.name ?? selectedSession?.currentTask
      : snapshot.review?.pullRequest?.title ?? selectedSession?.name ?? selectedSession?.currentTask,
    selectedSession?.isCurrentSession ? 'Q ↔ Mister live' : selectedSession?.name ?? 'Current session',
    26,
  );
  const activeSubtitle = compactLine(
    isOwnedCodexSession
      ? (selectedReviewPacket?.repoSlug && selectedReviewPacket?.branch ? `/${selectedReviewPacket.repoSlug}/${selectedReviewPacket.branch}` : selectedSession?.sessionKey)
      : (snapshot.review ? `/${snapshot.review.repoSlug}/${snapshot.review.branch}` : selectedSession?.sessionKey),
    selectedSession?.sessionKey ?? 'mobile/live',
    42,
  );
  const headerLabel = isOwnedCodexSession
    ? (selectedSession?.runtimeSurface?.capabilities.interrupt ? 'Codex live' : selectedSession?.runtimeSurface?.capabilities.sendInput ? 'Codex chat' : 'Codex watch')
    : selectedSession?.status === 'running'
      ? 'Live'
      : snapshot.review?.pullRequest
        ? 'Review'
        : 'Session';
  const headerProgress = Math.min(scrollY / 88, 1);
  const isHeaderCompact = headerProgress > 0.12;
  const isComposerPrimed = isOpenClawSession && (composeFocused || transcriptAttachments.length > 0);
  const dockMotionProgress = !isComposerPrimed && isScrolling ? 1 : 0;
  const dockFadeProgress = dockMotionProgress;
  const diffFileLabel = reviewFiles.length === 1 ? 'file' : 'files';
  const contextUsedPercent = Math.round(selectedSession?.context.usedPercent ?? 0);
  const ownedAvailability = selectedSession?.runtimeSurface?.lifecycle?.availability;
  const ownedLastOutcome = selectedSession?.runtimeSurface?.lifecycle?.lastOutcome;
  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;
  const ownedQueuedTurn = Boolean(pendingOwnedTurn) || transcriptActionState === 'steering';
  const canResumeOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.sendInput && !ownedQueuedTurn);
  const canInterruptOwnedCodex = Boolean(isOwnedCodexSession && selectedSession?.runtimeSurface?.capabilities.interrupt);

  useEffect(() => {
    if (!selectedSessionKey?.startsWith('codex-owned:')) {
      return;
    }

    const pendingTurn = pendingOwnedTurnBySession[selectedSessionKey];
    if (!pendingTurn) {
      return;
    }

    const sessionGroups = historyGroupsBySession[selectedSessionKey] ?? [];
    const matchingGroup = sessionGroups.find((group) => {
      const promptMatches = group.prompt.trim() === pendingTurn.prompt.trim();
      const startedAt = group.startedAt ? new Date(group.startedAt).getTime() : 0;
      return promptMatches || (startedAt > 0 && startedAt >= pendingTurn.createdAt - 1000);
    });

    const runSettledAgain = Boolean(
      selectedSession?.runtimeSurface?.capabilities.sendInput
      && !selectedSession?.runtimeSurface?.capabilities.interrupt
      && transcriptActionState === 'idle',
    );

    if (!matchingGroup && !runSettledAgain) {
      return;
    }

    setPendingOwnedTurnBySession((current) => {
      if (!current[selectedSessionKey]) {
        return current;
      }
      const next = { ...current };
      delete next[selectedSessionKey];
      return next;
    });
  }, [historyGroupsBySession, pendingOwnedTurnBySession, selectedSession?.runtimeSurface?.capabilities.interrupt, selectedSession?.runtimeSurface?.capabilities.sendInput, selectedSessionKey, transcriptActionState]);

  const statusTone = isOwnedCodexSession
    ? ownedLifecycleTone(ownedAvailability, ownedLastOutcome)
    : contextPressureTone(contextUsedPercent);
  const statusHeadline = isOwnedCodexSession
    ? ownedLifecycleLabel(ownedAvailability)
    : `${contextUsedPercent}% used`;
  const statusMeta = isOwnedCodexSession
    ? [ownedOutcomeLabel(ownedLastOutcome), ownedReviewDispositionLabel(ownedReviewDisposition)].join(' • ')
    : contextTrendLabel(selectedSession?.context.trend);

  const shellStyle = {
    '--remodex-header-progress': headerProgress.toFixed(3),
    '--remodex-dock-fade-progress': dockFadeProgress.toFixed(3),
    '--remodex-dock-motion-progress': dockMotionProgress.toFixed(3),
    '--remodex-compose-active': isComposerPrimed ? '1' : '0',
    '--remodex-viewport-top-offset': `${viewportTopOffset}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!selectedSessionKey || typeof window === 'undefined') {
      return;
    }
    if (!transcriptEntries.length && !transcriptGroups.length && !pendingOwnedTurn) {
      return;
    }

    const isFirstLoad = !initialBottomPinBySessionRef.current[selectedSessionKey];
    if (isFirstLoad) {
      // First load: always pin to bottom immediately (no smooth — instant)
      initialBottomPinBySessionRef.current[selectedSessionKey] = true;
      const runPin = () => transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
      const frameA = window.requestAnimationFrame(() => {
        runPin();
        window.requestAnimationFrame(runPin);
      });
      return () => window.cancelAnimationFrame(frameA);
    }

    // Subsequent updates: only scroll if user is already near the bottom
    if (!stickToBottomRef.current) {
      return; // user scrolled up — don't interrupt them
    }

    // Smooth scroll to bottom for new content
    const frame = window.requestAnimationFrame(() => {
      transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingOwnedTurn, scrollMarker, selectedSessionKey]);

  async function handleAttachmentSelection(files: FileList | null) {
    if (!selectedSessionKey || !files?.length) {
      return;
    }
    if (!isOpenClawSession) {
      setSurfaceNote('Image attachments are only available on the Mister lane right now.');
      return;
    }

    const chosenFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!chosenFiles.length) {
      setSurfaceNote('Only image attachments are supported right now.');
      return;
    }

    try {
      const nextAttachments = await Promise.all(chosenFiles.slice(0, 4).map(async (file, index) => {
        if (file.size > 5_000_000) {
          throw new Error(`${file.name} is too large. Keep image attachments under 5 MB.`);
        }
        const content = await fileToDataUrl(file);
        return {
          id: `${file.name}:${file.lastModified}:${index}`,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          content,
          previewUrl: URL.createObjectURL(file),
        } satisfies DraftAttachment;
      }));

      setDraftAttachmentsBySession((current) => ({
        ...current,
        [selectedSessionKey]: [...(current[selectedSessionKey] ?? []), ...nextAttachments].slice(0, 4),
      }));
      setSurfaceNote(`Attached ${nextAttachments.length} image${nextAttachments.length === 1 ? '' : 's'}.`);
      window.requestAnimationFrame(() => composeRef.current?.focus());
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : 'Unable to prepare these image attachments.');
    }
  }

  function removeDraftAttachment(sessionKey: string, attachmentId: string) {
    setDraftAttachmentsBySession((current) => {
      const existing = current[sessionKey] ?? [];
      const removed = existing.find((item) => item.id === attachmentId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      const remaining = existing.filter((item) => item.id !== attachmentId);
      return {
        ...current,
        [sessionKey]: remaining,
      };
    });
  }

  async function runAction(payload: MobileActionRequest) {
    const sessionKey = payload.sessionKey;
    const nextState = payload.action === 'stop'
      ? 'stopping'
      : payload.action === 'watch' || payload.action === 'resolve'
        ? 'reviewing'
        : 'steering';

    setActionStateBySession((current) => ({
      ...current,
      [sessionKey]: nextState,
    }));

    try {
      const response = await fetch('/api/mobile/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await readJson<MobileActionResponse>(response);
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: result.note }));
      window.setTimeout(() => {
        setActionNoteBySession((current) => (current[sessionKey] === result.note ? { ...current, [sessionKey]: null } : current));
      }, 3000);
      await refreshInbox();
      await loadHistory(sessionKey, true).catch(() => undefined);
      if (sessionKey.startsWith('codex-owned:')) {
        await loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
      }
      return result;
    } finally {
      setActionStateBySession((current) => ({ ...current, [sessionKey]: 'idle' }));
    }
  }

  function playSendClick() {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    } catch { /* audio not available */ }
  }

  async function handleSteerSubmit(sessionKey: string) {
    if (actionStateBySession[sessionKey] === 'steering') return;

    const targetSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey);
    if (targetSession?.runtime !== 'openclaw') {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Use the Codex resume lane instead — steer is for the Mister lane only.',
      }));
      return;
    }

    const message = draftBySession[sessionKey]?.trim();
    const attachments = draftAttachmentsBySession[sessionKey] ?? [];
    if (!message && attachments.length === 0) {
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Type a message or attach an image first.' }));
      return;
    }

    playSendClick();

    // Show typing indicator until a new assistant message arrives
    lastAssistantCountRef.current = transcriptEntries.filter((e) => e.role === 'assistant').length;
    setWaitingForResponse(true);

    // Optimistic: inject user message into transcript immediately
    const optimisticEntry: MobileTranscriptEntry = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      text: message ?? '',
      media: attachments.length > 0
        ? attachments.map((a) => ({ kind: 'image' as const, path: a.previewUrl, name: a.fileName }))
        : undefined,
      timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
    setHistoryBySession((current) => ({
      ...current,
      [sessionKey]: [...(current[sessionKey] ?? []), optimisticEntry],
    }));

    // Optimistic: clear UI immediately before the API round-trip
    setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
    setDraftAttachmentsBySession((current) => ({ ...current, [sessionKey]: [] }));
    attachments.forEach((item) => {
      URL.revokeObjectURL(item.previewUrl);
    });
    setSurfaceNote(
      attachments.length > 0
        ? `Sent with ${attachments.length} image${attachments.length === 1 ? '' : 's'}.`
        : 'Sent.',
    );

    try {
      await runAction({
        action: 'steer',
        sessionKey,
        message,
        attachments: attachments.map((item) => ({
          type: 'image',
          mimeType: item.mimeType,
          fileName: item.fileName,
          content: item.content,
        })),
      });
    } catch (error) {
      // Restore draft on failure so the user doesn't lose their message
      setDraftBySession((current) => ({ ...current, [sessionKey]: message ?? '' }));
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Failed to send. Message restored.',
      }));
    }
  }

  function handleLoadOwnedCorrectionDraft(sessionKey: string) {
    const packet = reviewPacketBySession[sessionKey];
    if (!packet) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Review packet is still loading. Refresh and try again.',
      }));
      return;
    }

    setDraftBySession((current) => ({
      ...current,
      [sessionKey]: buildOwnedCorrectionDraft(packet),
    }));
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: 'Loaded correction draft from review packet.',
    }));
    window.requestAnimationFrame(() => composeRef.current?.focus());
  }

  async function handleOwnedResumeSubmit(sessionKey: string) {
    if (actionStateBySession[sessionKey] === 'steering') return;

    const message = draftBySession[sessionKey]?.trim();
    if (!message) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: 'Write an instruction or load the correction draft first.',
      }));
      return;
    }

    playSendClick();

    const pendingTurn: PendingOwnedTurn = {
      id: `pending-${Date.now()}`,
      prompt: message,
      createdAt: Date.now(),
      timestampLabel: mobileClockFormatter.format(new Date()),
    };

    setPendingOwnedTurnBySession((current) => ({
      ...current,
      [sessionKey]: pendingTurn,
    }));

    // Optimistic: clear draft immediately
    setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
    setSurfaceNote('Turn queued.');

    try {
      await runAction({
        action: 'resume',
        sessionKey,
        message,
      });
    } catch (error) {
      setPendingOwnedTurnBySession((current) => {
        if (!current[sessionKey]) {
          return current;
        }
        const next = { ...current };
        delete next[sessionKey];
        return next;
      });
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Unable to resume the owned Codex session from mobile.',
      }));
    }
  }

  function optimisticallySetOwnedReviewDisposition(
    sessionKey: string,
    disposition: RuntimeReviewPacket['reviewDisposition'],
  ) {
    const updatedAt = new Date().toISOString();
    setReviewPacketBySession((current) => {
      const existing = current[sessionKey];
      if (!existing) {
        return current;
      }
      return {
        ...current,
        [sessionKey]: {
          ...existing,
          reviewDisposition: disposition,
          reviewDispositionUpdatedAt: updatedAt,
          reviewDispositionUpdatedAtLabel: 'Just now',
        },
      };
    });
  }

  async function handleOwnedReviewDisposition(action: 'watch' | 'resolve', sessionKey: string) {
    const previousPacket = reviewPacketBySession[sessionKey];
    const nextDisposition = action === 'resolve' ? 'resolved' : 'watching';

    if (previousPacket) {
      optimisticallySetOwnedReviewDisposition(sessionKey, nextDisposition);
    }

    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: action === 'resolve' ? 'Marking resolved…' : 'Switching to watching…',
    }));

    try {
      const result = await runAction({
        action,
        sessionKey,
      });
      setSurfaceNote(result.note);
    } catch (error) {
      if (previousPacket) {
        setReviewPacketBySession((current) => ({
          ...current,
          [sessionKey]: previousPacket,
        }));
      }
      void loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Unable to update the owned review state from mobile.',
      }));
    }
  }

  function handleCopy(text: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setSurfaceNote('Clipboard is not available on this browser.');
      return;
    }

    void navigator.clipboard.writeText(text).then(() => {
      setSurfaceNote('Copied to clipboard.');
    }).catch(() => {
      setSurfaceNote('Could not copy to the clipboard.');
    });
  }

  async function handleSurfaceRefresh() {
    setSurfaceRefreshing(true);
    try {
      const nextSnapshot = await refreshInbox();
      const nextSessionKey = selectedSessionKey
        ?? nextSnapshot.primarySessionKey
        ?? nextSnapshot.sessions.find((session) => session.isCurrentSession)?.sessionKey
        ?? nextSnapshot.sessions[0]?.sessionKey;
      let nextReviewPath = selectedReviewFilePath;

      if (nextSessionKey) {
        await loadHistory(nextSessionKey, true).catch(() => undefined);
        if (nextSessionKey.startsWith('codex-owned:')) {
          const packet = await loadOwnedReviewPacket(nextSessionKey, true).catch(() => null);
          nextReviewPath = nextReviewPath ?? packet?.changedFiles[0]?.path ?? null;
        } else {
          nextReviewPath = nextReviewPath ?? nextSnapshot.review?.changedFiles[0]?.path ?? null;
        }
      }
      if (nextReviewPath) {
        await loadReviewFile(nextReviewPath, true).catch(() => undefined);
      }
      setSurfaceNote('Refreshed.');
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : 'Unable to refresh the mobile surface right now.');
    } finally {
      setSurfaceRefreshing(false);
    }
  }

  function handleSessionFocus(sessionId: string) {
    const nextSession = snapshot.sessions.find((session) => session.id === sessionId);
    if (!nextSession?.sessionKey) {
      return;
    }

    setSelectedId(sessionId);
    setControlsOpen(false);
    setDiffOpen(false);
    setSurfaceNote(`Focused ${compactLine(nextSession.name, 'the selected session', 40)}.`);

    void (async () => {
      await loadHistory(nextSession.sessionKey).catch(() => undefined);
      if (!nextSession.sessionKey.startsWith('codex-owned:')) {
        return;
      }
      const packet = await loadOwnedReviewPacket(nextSession.sessionKey).catch(() => null);
      const nextPath = packet?.changedFiles[0]?.path;
      if (!nextPath) {
        return;
      }
      setSelectedReviewFilePath(nextPath);
      await loadReviewFile(nextPath).catch(() => undefined);
    })();
  }

  async function handleStopActiveRun() {
    if (!selectedSessionKey) {
      return;
    }
    if (!isOpenClawSession && !canInterruptOwnedCodex) {
      setSurfaceNote('No active run to interrupt right now.');
      return;
    }
    if (!window.confirm(isOwnedCodexSession ? 'Interrupt the active owned Codex run?' : 'Stop the active run for this session?')) {
      return;
    }

    try {
      const result = await runAction({
        action: 'stop',
        sessionKey: selectedSessionKey,
      });
      setSurfaceNote(result.note);
      setControlsOpen(false);
    } catch (error) {
      setSurfaceNote(error instanceof Error ? error.message : isOwnedCodexSession ? 'Unable to interrupt the owned Codex run from mobile.' : 'Unable to stop the active run from mobile.');
    }
  }

  function openDiffViewer() {
    if (!reviewFiles.length) {
      setSurfaceNote('No active diff to review right now.');
      return;
    }

    const nextPath = selectedReviewFilePath ?? reviewFiles[0]?.path ?? null;
    if (nextPath) {
      setSelectedReviewFilePath(nextPath);
      if (!reviewFileByPath[nextPath]) {
        void loadReviewFile(nextPath).catch(() => undefined);
      }
    }

    setControlsOpen(false);
    setDiffOpen(true);
  }

  function handleReviewFileFocus(reviewPath: string) {
    setSelectedReviewFilePath(reviewPath);
    void loadReviewFile(reviewPath).catch(() => undefined);
  }

  function jumpReviewFile(direction: 'prev' | 'next') {
    if (!reviewFiles.length) {
      return;
    }

    const fallbackIndex = direction === 'prev' ? reviewFiles.length - 1 : 0;
    const currentIndex = selectedReviewFileIndex >= 0 ? selectedReviewFileIndex : fallbackIndex;
    const nextIndex = direction === 'prev'
      ? Math.max(0, currentIndex - 1)
      : Math.min(reviewFiles.length - 1, currentIndex + 1);
    const nextFile = reviewFiles[nextIndex];
    if (!nextFile) {
      return;
    }

    handleReviewFileFocus(nextFile.path);
  }

  function renderMediaGrid(media: MobileTranscriptMedia[], align: 'left' | 'right' = 'left') {
    return (
      <div className={`remodex-media-grid ${align === 'right' ? 'remodex-media-grid-right' : ''}`}>
        {media.map((item) => {
          if (isImageMedia(item)) {
            return (
              <button
                key={item.path}
                type="button"
                className="remodex-media-card remodex-media-card-image"
                onClick={() => setExpandedMedia(item)}
              >
                <Image
                  src={mediaHref(item.path)}
                  alt={item.name}
                  width={1200}
                  height={900}
                  unoptimized
                  loading="lazy"
                  onLoadingComplete={() => {
                    if (stickToBottomRef.current) {
                      window.requestAnimationFrame(() => scrollToLatestMessage());
                    }
                  }}
                />
                <span className="remodex-media-card-caption">Tap to expand</span>
              </button>
            );
          }

          return (
            <div key={item.path} className="remodex-media-card remodex-media-card-file">
              <div className="remodex-media-file-icon">
                {item.kind === 'pdf' ? <FileText size={18} strokeWidth={2.1} /> : <ImageIcon size={18} strokeWidth={2.1} />}
              </div>
              <div className="remodex-media-file-copy">
                <strong>{item.name}</strong>
                <span>{item.kind === 'pdf' ? 'PDF artifact' : 'File artifact'}</span>
              </div>
              <div className="remodex-media-file-actions">
                <a href={mediaHref(item.path)} target="_blank" rel="noreferrer">Open</a>
                <a href={mediaHref(item.path, true)} download={item.name}>Save</a>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mobile-wrap remodex-mobile-page" style={shellStyle} suppressHydrationWarning>
      <div className="remodex-phone-shell">
        <header
          className="remodex-topbar"
          data-compact={isHeaderCompact ? 'true' : 'false'}
          data-context-visible="false"
          data-visible={headerVisible ? 'true' : 'false'}
        >
          <button
            type="button"
            className="remodex-circle-button"
            aria-label="Conversation controls"
            onClick={() => setControlsOpen(true)}
            style={{ background: '#ef4444', color: '#ffffff', border: 'none', boxShadow: '0 4px 12px rgba(239,68,68,0.25)' }}
          >
            <Menu size={18} strokeWidth={2.1} />
          </button>
          <div className="remodex-title-shell">
            <div className="remodex-title-stack">
              <span className="remodex-title-kicker">{headerLabel}</span>
              <h1>{activeTitle}</h1>
              <p>{activeSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            className="remodex-diff-pill"
            onClick={openDiffViewer}
            disabled={!reviewFiles.length}
            aria-label={`Open diff sheet with +${focusedAdditions ?? 0}, -${focusedDeletions ?? 0}, ${reviewFiles.length} ${diffFileLabel}`}
          >
            <span className="remodex-diff-pill-stats" aria-hidden="true">
              <span className="remodex-diff-pill-chip remodex-diff-pill-chip-add">+{focusedAdditions ?? 0}</span>
              <span className="remodex-diff-pill-chip remodex-diff-pill-chip-remove">-{focusedDeletions ?? 0}</span>
            </span>
            <span className="remodex-diff-pill-meta">
              <span className="remodex-diff-pill-count">{reviewFiles.length}</span>
              <span className="remodex-diff-pill-caption">{diffFileLabel}</span>
            </span>
            <SlidersHorizontal size={15} strokeWidth={2} />
          </button>

        </header>

        <div className="remodex-scroll-view">

          {threadSwitcher.length > 0 ? (
            <div className="remodex-squad-rail">
              {threadSwitcher.map((session) => {
                const active = session.id === selectedSession?.id;
                const isRunning = session.status === 'running' || session.status === 'reviewing';
                const ctxPct = Math.round(session.context?.usedPercent ?? 0);
                const ctxTone = ctxPct >= 85 ? 'critical' : ctxPct >= 75 ? 'high' : ctxPct >= 65 ? 'watch' : 'calm';
                const agentName = session.isCurrentSession ? 'Mister' : session.name?.split(/[\s/]/)[0] ?? 'Agent';
                const taskLine = session.isCurrentSession
                  ? 'Main session'
                  : session.currentTask
                    ? compactLine(session.currentTask, '', 32)
                    : session.status;
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`remodex-squad-card ${active ? 'remodex-squad-card-active' : ''}`}
                    onClick={() => handleSessionFocus(session.id)}
                  >
                    <div className="remodex-squad-card-head">
                      <span className={`remodex-squad-dot ${isRunning ? 'remodex-squad-dot-live' : ''} remodex-squad-dot-${ctxTone}`} />
                      <strong className="remodex-squad-name">{agentName}</strong>
                      <span className="remodex-squad-time">{session.lastEventAt ?? 'idle'}</span>
                    </div>
                    <span className="remodex-squad-task">{taskLine}</span>
                    <div className="remodex-squad-bar-track">
                      <div
                        className={`remodex-squad-bar-fill remodex-squad-bar-${ctxTone}`}
                        style={{ width: `${ctxPct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {statusTone !== 'calm' ? (
            <div className={`remodex-context-system-msg remodex-context-system-msg-${statusTone}`}>
              <span className="remodex-context-system-dot" />
              <span>{statusHeadline} · {statusMeta}</span>
            </div>
          ) : null}

          {isOwnedCodexSession && (selectedReviewPacket || selectedReviewPacketLoading || selectedReviewPacketError) ? (
            <div className={`remodex-owned-review-card remodex-context-card remodex-context-card-${ownedReviewDispositionTone(ownedReviewDisposition)}`}>
              <div className="remodex-owned-review-head">
                <div className="remodex-context-card-copy">
                  <span className="remodex-context-card-kicker">Review packet</span>
                  <strong>{ownedReviewDispositionLabel(ownedReviewDisposition)}</strong>
                </div>
                <span className="remodex-context-card-trend">
                  {selectedReviewPacket?.reviewDispositionUpdatedAtLabel
                    ? `Updated ${selectedReviewPacket.reviewDispositionUpdatedAtLabel}`
                    : selectedReviewPacketLoading
                      ? 'Loading…'
                      : `${reviewFiles.length} file${reviewFiles.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {selectedReviewPacket ? (
                <>
                  <p className="remodex-owned-review-copy">{selectedReviewPacket.summary}</p>
                  <div className="remodex-owned-review-actions">
                    <button
                      type="button"
                      className="remodex-controls-action"
                      onClick={() => openDiffViewer()}
                      disabled={!reviewFiles.length}
                    >
                      <FileDiff size={16} strokeWidth={2.1} />
                      Open exact diff
                    </button>
                    <button
                      type="button"
                      className="remodex-controls-action"
                      onClick={() => selectedSessionKey && handleLoadOwnedCorrectionDraft(selectedSessionKey)}
                      disabled={!selectedSessionKey || !canResumeOwnedCodex}
                    >
                      <ArrowUp size={16} strokeWidth={2.1} />
                      Draft reply
                    </button>
                    <button
                      type="button"
                      className="remodex-controls-action"
                      onClick={() => selectedSessionKey && void handleOwnedReviewDisposition(selectedReviewPacket.reviewDisposition === 'resolved' ? 'watch' : 'resolve', selectedSessionKey)}
                      disabled={!selectedSessionKey || transcriptActionState !== 'idle'}
                    >
                      {selectedReviewPacket.reviewDisposition === 'resolved' ? <Eye size={16} strokeWidth={2.1} /> : <Check size={16} strokeWidth={2.1} />}
                      {selectedReviewPacket.reviewDisposition === 'resolved' ? 'Keep watching' : 'Mark resolved'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {refreshError ? <p className="remodex-banner-note">{refreshError}</p> : null}
          {surfaceNote ? <p className="remodex-banner-note">{surfaceNote}</p> : null}
          {transcriptError ? <p className="remodex-banner-note">{transcriptError}</p> : null}
          {selectedReviewPacketError ? <p className="remodex-banner-note">{selectedReviewPacketError}</p> : null}

          <div className="remodex-message-stack">
            {isOwnedCodexSession && (transcriptGroups.length || pendingOwnedTurn) ? (
              <>
                {transcriptGroups.map((group) => {
                  const promptText = group.prompt.trim();
                  const visibleEntries = group.entries.filter((entry) => {
                    const text = entry.text.trim();
                    if (!text) {
                      return false;
                    }
                    if (promptText && text === promptText) {
                      return false;
                    }
                    return true;
                  });

                  return (
                    <article key={group.id} className="remodex-message-card remodex-message-card-assistant remodex-owned-turn-card">
                  <div className="remodex-owned-turn-head">
                    <div className="remodex-owned-turn-head-copy">
                      <span className="remodex-owned-turn-kicker">{group.mode === 'launch' ? 'Launch turn' : 'Reply turn'}</span>
                      <strong>{group.title}</strong>
                    </div>
                    <div className="remodex-owned-turn-chip-row">
                      <span className="remodex-compose-chip remodex-compose-pill">{group.mode}</span>
                      <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{group.outcome}</span>
                    </div>
                  </div>

                  {promptText ? (
                    <div className="remodex-user-turn-wrap">
                      <div className="remodex-user-bubble">{renderMessageBody(promptText, `${group.id}-prompt`)}</div>
                      <span className="remodex-turn-time">{group.startedAtLabel ?? 'now'}</span>
                    </div>
                  ) : null}

                  <div className="remodex-owned-turn-note">
                    <span className="remodex-owned-turn-note-kicker">Codex status</span>
                    <p>{group.summary}</p>
                  </div>

                  <div className="remodex-owned-chat-list">
                    {visibleEntries.map((entry) => {
                      const hasText = Boolean(entry.text.trim());
                      if (!hasText) {
                        return null;
                      }

                      if (entry.role === 'user') {
                        return (
                          <div key={entry.id} className="remodex-user-turn-wrap">
                            <div className="remodex-user-bubble">{renderMessageBody(entry.text, `${entry.id}-user`)}</div>
                            <span className="remodex-turn-time">{entry.timestampLabel ?? group.finishedAtLabel ?? group.startedAtLabel ?? 'now'}</span>
                          </div>
                        );
                      }

                      return (
                        <article
                          key={entry.id}
                          className={`remodex-message-card remodex-message-card-assistant remodex-owned-chat-bubble ${entry.role !== 'assistant' ? 'remodex-owned-chat-bubble-muted' : ''}`}
                        >
                          <div className="remodex-message-head">
                            <span>{entry.role === 'assistant' ? 'Codex' : roleLabel(entry.role)}</span>
                            <div className="remodex-message-tools">
                              <span className="remodex-turn-time">{entry.timestampLabel ?? group.finishedAtLabel ?? group.startedAtLabel ?? 'now'}</span>
                              <button type="button" className="remodex-icon-link" onClick={() => handleCopy(entry.text)} aria-label="Copy message">
                                <Copy size={16} strokeWidth={2.1} />
                              </button>
                            </div>
                          </div>
                          {renderMessageBody(entry.text, `${entry.id}-owned`)}
                        </article>
                      );
                    })}
                  </div>
                    </article>
                  );
                })}
                {pendingOwnedTurn ? (
                  <article className="remodex-message-card remodex-message-card-assistant remodex-owned-turn-card remodex-owned-turn-card-pending">
                    <div className="remodex-owned-turn-head">
                      <div className="remodex-owned-turn-head-copy">
                        <span className="remodex-owned-turn-kicker">Queued turn</span>
                        <strong>Codex is starting this turn</strong>
                      </div>
                      <div className="remodex-owned-turn-chip-row">
                        <span className="remodex-compose-chip remodex-compose-pill">resume</span>
                        <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">queued</span>
                      </div>
                    </div>
                    <div className="remodex-user-turn-wrap">
                      <div className="remodex-user-bubble">{renderMessageBody(pendingOwnedTurn.prompt, `${pendingOwnedTurn.id}-pending-prompt`)}</div>
                      <span className="remodex-turn-time">{pendingOwnedTurn.timestampLabel}</span>
                    </div>
                    <div className="remodex-owned-turn-note">
                      <span className="remodex-owned-turn-note-kicker">Codex status</span>
                      <p>Starting up — interrupt will appear once the run is active.</p>
                    </div>
                  </article>
                ) : null}
              </>
            ) : transcriptEntries.length ? transcriptEntries.map((entry, index) => {
              const isUser = entry.role === 'user';
              const isLatest = !transcriptEntries.slice(index + 1).some((e) => e.role === 'assistant');
              const hasText = Boolean(entry.text.trim());
              const hasMedia = Boolean(entry.media?.length);
              const isNewMessage = hydrated && seenMessageIdsRef.current != null && !seenMessageIdsRef.current.has(entry.id);
              if (isNewMessage) seenMessageIdsRef.current?.add(entry.id);
              const fadeClass = isNewMessage ? ' remodex-turn-new' : '';
              const prevEntry = index > 0 ? transcriptEntries[index - 1] : null;
              const speakerChanged = !prevEntry || prevEntry.role !== entry.role;
              // Smart timestamps: only show if 15+ min gap from previous entry
              const showTimestamp = (() => {
                if (!prevEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
                const prev = new Date(`1970-01-01 ${prevEntry.timestampLabel}`).getTime();
                const curr = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
                if (Number.isNaN(prev) || Number.isNaN(curr)) return speakerChanged;
                return Math.abs(curr - prev) >= 15 * 60 * 1000;
              })();

              if (isUser) {
                return (
                  <div key={entry.id} className={`remodex-user-turn-wrap${fadeClass}`}>
                    {hasText ? <div className="remodex-user-bubble">{renderMessageBody(entry.text, `${entry.id}-user`)}</div> : null}
                    {hasMedia ? renderMediaGrid(entry.media ?? [], 'right') : null}
                    {showTimestamp ? <span className="remodex-turn-time">{entry.timestampLabel ?? 'now'}</span> : null}
                  </div>
                );
              }

              // Compaction events get a special card
              const isCompaction = entry.role === 'system' && entry.text.toLowerCase().includes('compaction');
              if (isCompaction) {
                return (
                  <div key={entry.id} className="remodex-compaction-card">
                    <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
                    <span className="remodex-compaction-label">Context compacted</span>
                    {showTimestamp ? <span className="remodex-compaction-time">{entry.timestampLabel ?? ''}</span> : null}
                  </div>
                );
              }

              const agentName = isOwnedCodexSession ? 'Codex' : (selectedSession?.isCurrentSession ? 'Mister' : undefined);

              return (
                <article key={entry.id} className={`remodex-message-card remodex-message-card-assistant${fadeClass}`}>
                  {speakerChanged ? (
                    <div className="remodex-message-head">
                      <span>{roleLabel(entry.role, agentName)}</span>
                    </div>
                  ) : null}
                  {hasText ? renderMessageBody(entry.text, `${entry.id}-assistant`) : null}
                  {hasMedia ? renderMediaGrid(entry.media ?? []) : null}
                  {isLatest && selectedReviewFile ? (
                    <button type="button" className="remodex-inline-diff-thumb" onClick={openDiffViewer}>
                      <div className="remodex-inline-diff-mini">
                        <FileDiff size={16} strokeWidth={1.8} />
                      </div>
                      <div className="remodex-inline-diff-copy">
                        <strong>{selectedReviewFile.path.split('/').pop() ?? selectedReviewFile.path}</strong>
                        <span>{`${selectedReviewFile.additions ?? 0} additions, ${selectedReviewFile.deletions ?? 0} removals`}</span>
                      </div>
                      <ChevronRight size={16} strokeWidth={1.6} className="remodex-inline-diff-chevron" />
                    </button>
                  ) : null}
                </article>
              );
            }) : transcriptLoading ? (
              <div className="remodex-skeleton-stack">
                <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
                <div className="remodex-skeleton-bubble remodex-skeleton-user" />
                <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
                <div className="remodex-skeleton-bubble remodex-skeleton-user remodex-skeleton-short" />
              </div>
            ) : (
              <div className="remodex-loading-card">
                {isOwnedCodexSession
                  ? 'No run history yet — waiting for the first readable output.'
                  : 'No transcript turns visible yet — latest activity may have been tool-heavy or compacted.'}
              </div>
            )}
          </div>

          {(waitingForResponse || actionStateBySession[selectedSessionKey ?? ''] === 'steering') ? (
            <div className="remodex-typing-bubble">
              <span className="remodex-typing-bubble-label">{isOwnedCodexSession ? 'Codex' : 'Mister'}</span>
              <div className="remodex-typing-bubble-dots">
                <span className="remodex-typing-dot" />
                <span className="remodex-typing-dot" />
                <span className="remodex-typing-dot" />
              </div>
            </div>
          ) : null}

          <div ref={transcriptBottomRef} className="remodex-scroll-anchor" aria-hidden="true" />
        </div>

        <div className="remodex-bottom-dock" data-active={isComposerPrimed ? 'true' : 'false'}>
          <div className="remodex-compose-shell">
            {isOpenClawSession ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="remodex-file-input-hidden"
                  onChange={(event) => {
                    void handleAttachmentSelection(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
                {transcriptAttachments.length ? (
                  <div className="remodex-attachment-strip">
                    {transcriptAttachments.map((attachment) => (
                      <div key={attachment.id} className="remodex-attachment-pill">
                        <Image src={attachment.previewUrl} alt={attachment.fileName} width={72} height={72} unoptimized />
                        <div className="remodex-attachment-pill-copy">
                          <strong>{compactLine(attachment.fileName, attachment.fileName, 20)}</strong>
                          <span>Ready to send</span>
                        </div>
                        <button
                          type="button"
                          className="remodex-attachment-pill-remove"
                          aria-label={`Remove ${attachment.fileName}`}
                          onClick={() => {
                            if (!selectedSessionKey) return;
                            removeDraftAttachment(selectedSessionKey, attachment.id);
                          }}
                        >
                          <X size={14} strokeWidth={2.2} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="remodex-compose-surface">
                  <div className="remodex-compose-status-bar">
                    <span className="remodex-compose-chip remodex-compose-pill">{selectedSession?.model ?? 'live'}</span>
                    <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{selectedSession?.status ?? 'idle'}</span>
                  </div>
                  <textarea
                    ref={composeRef}
                    className="remodex-compose-input"
                    rows={2}
                    value={transcriptDraft}
                    onChange={(event) => {
                      if (!selectedSessionKey) return;
                      const value = event.target.value;
                      setDraftBySession((current) => ({ ...current, [selectedSessionKey]: value }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && selectedSessionKey && transcriptDraft.trim()) {
                        event.preventDefault();
                        void handleSteerSubmit(selectedSessionKey);
                      }
                    }}
                    onFocus={() => setComposeFocused(true)}
                    onBlur={() => setComposeFocused(false)}
                    placeholder={transcriptAttachments.length ? 'Add context for the image…' : 'Message Mister…'}
                  />
                  <div className="remodex-compose-row">
                    <button
                      type="button"
                      className="remodex-compose-chip remodex-compose-chip-icon"
                      aria-label="Attach image"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Plus size={16} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      className="remodex-compose-chip remodex-compose-chip-icon"
                      aria-label="Refresh conversation"
                      onClick={() => {
                        void handleSurfaceRefresh();
                      }}
                    >
                      <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
                    </button>
                    <button
                      type="button"
                      style={(() => {
                        const isDisabled = !selectedSessionKey || transcriptActionState !== 'idle' || (!transcriptDraft.trim() && transcriptAttachments.length === 0);
                        return {
                          marginLeft: 'auto',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '0.32rem',
                          minWidth: 42,
                          minHeight: 42,
                          padding: '0 0.82rem',
                          borderRadius: 999,
                          border: 'none',
                          background: isDisabled ? '#d1d5db' : '#ef4444',
                          color: isDisabled ? '#9ca3af' : '#ffffff',
                          fontSize: '0.84rem',
                          fontWeight: 700,
                          boxShadow: isDisabled ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
                          cursor: isDisabled ? 'default' : 'pointer',
                        } satisfies CSSProperties;
                      })()}
                      disabled={!selectedSessionKey || transcriptActionState !== 'idle' || (!transcriptDraft.trim() && transcriptAttachments.length === 0)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (!selectedSessionKey) return;
                        void handleSteerSubmit(selectedSessionKey);
                      }}
                      aria-label="Send message to Mister"
                    >
                      {transcriptActionState === 'steering' ? (
                        <>
                          <RefreshCw size={17} className="spin" />
                          <span>Sending</span>
                        </>
                      ) : (
                        <>
                          <ArrowUp size={17} strokeWidth={2.2} />
                          <span>Send</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : canResumeOwnedCodex ? (
              <div className="remodex-compose-surface remodex-compose-surface-watch">
                <div className="remodex-watch-card">
                  <div className="remodex-watch-copy">
                    <strong>Message Codex</strong>
                    <p>Send the next turn between runs. Queues immediately — output lands once Codex starts.</p>
                  </div>
                  <textarea
                    ref={composeRef}
                    className="remodex-compose-input"
                    rows={2}
                    value={transcriptDraft}
                    onChange={(event) => {
                      if (!selectedSessionKey) return;
                      const value = event.target.value;
                      setDraftBySession((current) => ({ ...current, [selectedSessionKey]: value }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && selectedSessionKey && transcriptDraft.trim()) {
                        event.preventDefault();
                        void handleOwnedResumeSubmit(selectedSessionKey);
                      }
                    }}
                    onFocus={() => setComposeFocused(true)}
                    onBlur={() => setComposeFocused(false)}
                    placeholder="Next instruction for Codex…"
                  />
                  <div className="remodex-owned-quick-actions">
                    <button
                      type="button"
                      className="remodex-compose-chip"
                      onClick={() => selectedSessionKey && handleLoadOwnedCorrectionDraft(selectedSessionKey)}
                      disabled={!selectedSessionKey || !selectedReviewPacket}
                    >
                      <ArrowUp size={15} strokeWidth={2.1} />
                      Draft reply
                    </button>
                    <button
                      type="button"
                      className="remodex-compose-chip"
                      onClick={openDiffViewer}
                      disabled={!reviewFiles.length}
                    >
                      <FileDiff size={15} strokeWidth={2.1} />
                      Exact diff
                    </button>
                  </div>
                  <div className="remodex-compose-row remodex-compose-row-watch remodex-compose-row-owned">
                    <button
                      type="button"
                      className="remodex-compose-chip remodex-compose-chip-icon"
                      aria-label="Refresh owned runtime surface"
                      onClick={() => {
                        void handleSurfaceRefresh();
                      }}
                    >
                      <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
                    </button>
                    <span className="remodex-compose-chip remodex-compose-pill">{selectedSession?.model ?? 'live'}</span>
                    <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{ownedLifecycleLabel(ownedAvailability)}</span>
                    <span className="remodex-compose-chip remodex-compose-pill">{ownedReviewDispositionLabel(ownedReviewDisposition)}</span>
                    <button
                      type="button"
                      style={(() => {
                        const isDisabled = !selectedSessionKey || transcriptActionState !== 'idle' || !transcriptDraft.trim();
                        return {
                          marginLeft: 'auto',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '0.32rem',
                          minWidth: 42,
                          minHeight: 42,
                          padding: '0 0.82rem',
                          borderRadius: 999,
                          border: 'none',
                          background: isDisabled ? '#d1d5db' : '#ef4444',
                          color: isDisabled ? '#9ca3af' : '#ffffff',
                          fontSize: '0.84rem',
                          fontWeight: 700,
                          boxShadow: isDisabled ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
                          cursor: isDisabled ? 'default' : 'pointer',
                        } satisfies CSSProperties;
                      })()}
                      disabled={!selectedSessionKey || transcriptActionState !== 'idle' || !transcriptDraft.trim()}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (!selectedSessionKey) return;
                        void handleOwnedResumeSubmit(selectedSessionKey);
                      }}
                      aria-label="Send next turn to owned Codex"
                    >
                      {transcriptActionState === 'steering' ? (
                        <>
                          <RefreshCw size={17} className="spin" />
                          <span>Sending</span>
                        </>
                      ) : (
                        <>
                          <ArrowUp size={17} strokeWidth={2.2} />
                          <span>Send</span>
                        </>
                      )}
                    </button>
                  </div>
                  <p className="remodex-compose-helper">Review diffs and send the next turn. Interrupt reappears while the run is active.</p>
                </div>
              </div>
            ) : (
              <div className="remodex-compose-surface remodex-compose-surface-watch">
                <div className="remodex-watch-card">
                  <div className="remodex-watch-copy">
                    <strong>{ownedQueuedTurn ? 'Turn queued' : canInterruptOwnedCodex ? 'Active run' : 'Review-first'}</strong>
                    <p>
                      {ownedQueuedTurn
                        ? 'Codex accepted the turn. This surface will promote into runtime watch once output starts landing.'
                        : canInterruptOwnedCodex
                          ? 'Interrupt is available while the run is active. Resume reappears once the run settles.'
                          : 'Review and diff context are live. Resume becomes available once the current run settles.'}
                    </p>
                  </div>
                  <div className="remodex-owned-quick-actions">
                    <button
                      type="button"
                      className="remodex-compose-chip"
                      onClick={openDiffViewer}
                      disabled={!reviewFiles.length}
                    >
                      <FileDiff size={15} strokeWidth={2.1} />
                      Exact diff
                    </button>
                    <button
                      type="button"
                      className="remodex-compose-chip"
                      onClick={() => selectedSessionKey && void handleOwnedReviewDisposition(ownedReviewDisposition === 'resolved' ? 'watch' : 'resolve', selectedSessionKey)}
                      disabled={!selectedSessionKey || !selectedReviewPacket || transcriptActionState !== 'idle'}
                    >
                      {ownedReviewDisposition === 'resolved' ? <Eye size={15} strokeWidth={2.1} /> : <Check size={15} strokeWidth={2.1} />}
                      {ownedReviewDisposition === 'resolved' ? 'Keep watching' : 'Mark resolved'}
                    </button>
                    {canInterruptOwnedCodex ? (
                      <button
                        type="button"
                        className="remodex-compose-chip remodex-compose-chip-danger"
                        onClick={() => void handleStopActiveRun()}
                        disabled={!selectedSessionKey || transcriptActionState !== 'idle'}
                      >
                        <Square size={15} strokeWidth={2.1} />
                        Interrupt run
                      </button>
                    ) : null}
                  </div>
                  <div className="remodex-compose-row remodex-compose-row-watch">
                    <button
                      type="button"
                      className="remodex-compose-chip remodex-compose-chip-icon"
                      aria-label="Refresh runtime watch"
                      onClick={() => {
                        void handleSurfaceRefresh();
                      }}
                    >
                      <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
                    </button>
                    <span className="remodex-compose-chip remodex-compose-pill">{selectedSession?.model ?? 'live'}</span>
                    <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{ownedLifecycleLabel(ownedAvailability)}</span>
                    <span className="remodex-compose-chip remodex-compose-pill">{ownedReviewDispositionLabel(ownedReviewDisposition)}</span>
                  </div>
                </div>
              </div>
            )}
            {transcriptActionNote ? <p className="remodex-inline-action-note">{transcriptActionNote}</p> : null}
          </div>

          <div className="remodex-runtime-bar">
            <div className={`remodex-runtime-pressure remodex-runtime-pressure-${statusTone}`}>
              <span className="remodex-pressure-dot" />
              <span className="remodex-pressure-label">{statusHeadline}</span>
              <span className="remodex-pressure-sep">·</span>
              <GitBranch size={12} strokeWidth={1.6} />
              <span className="remodex-pressure-branch">{compactLine(snapshot.review?.branch ?? selectedSession?.branch ?? 'main', 'main', 18)}</span>
            </div>
          </div>
        </div>
      </div>

      {controlsOpen ? (
        <div className="remodex-controls-overlay" role="dialog" aria-modal="true" onClick={() => setControlsOpen(false)}>
          <section className="remodex-controls-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="remodex-diff-sheet-head remodex-sheet-head-generic">
              <div className="remodex-diff-sheet-handle" />
              <h2>{selectedSession?.isCurrentSession ? 'Q ↔ Mister' : compactLine(selectedSession?.name, 'Session', 24)}</h2>
              <button type="button" className="remodex-done-button remodex-done-tinted" onClick={() => setControlsOpen(false)}>
                Done
              </button>
            </div>

            <div className="remodex-controls-action-list">
              <button type="button" className="remodex-controls-action-row" onClick={() => { void handleSurfaceRefresh(); setControlsOpen(false); }}>
                <span className="remodex-action-row-icon"><RefreshCw size={18} strokeWidth={1.8} className={surfaceRefreshing ? 'spin' : undefined} /></span>
                <span className="remodex-action-row-label">Refresh</span>
              </button>
              <button type="button" className="remodex-controls-action-row" onClick={openDiffViewer} disabled={!reviewFiles.length}>
                <span className="remodex-action-row-icon"><FileDiff size={18} strokeWidth={1.8} /></span>
                <span className="remodex-action-row-label">Changes</span>
                {reviewFiles.length ? <span className="remodex-action-row-badge">{reviewFiles.length}</span> : null}
              </button>
              <button
                type="button"
                className="remodex-controls-action-row"
                disabled={!selectedSessionKey}
                onClick={() => {
                  handleCopy(selectedSessionKey ?? '');
                  setControlsOpen(false);
                }}
              >
                <span className="remodex-action-row-icon"><Copy size={18} strokeWidth={1.8} /></span>
                <span className="remodex-action-row-label">Copy session key</span>
              </button>
              <Link href="/" className="remodex-controls-action-row remodex-controls-action-link" onClick={() => setControlsOpen(false)}>
                <span className="remodex-action-row-icon"><Monitor size={18} strokeWidth={1.8} /></span>
                <span className="remodex-action-row-label">Open on desktop</span>
                <ChevronRight size={16} strokeWidth={1.8} className="remodex-action-row-chevron" />
              </Link>
              {(isOpenClawSession && selectedSession?.status === 'running') || canInterruptOwnedCodex ? (
                <button type="button" className="remodex-controls-action-row remodex-controls-action-row-danger" onClick={() => void handleStopActiveRun()}>
                  <span className="remodex-action-row-icon"><Square size={18} strokeWidth={1.8} /></span>
                  <span className="remodex-action-row-label">{isOwnedCodexSession ? 'Interrupt run' : 'Stop run'}</span>
                </button>
              ) : null}
            </div>

            {sessionSwitcher.length > 1 ? (
              <div className="remodex-controls-session-list">
                <span className="remodex-controls-label">Sessions</span>
                <div className="remodex-controls-session-grid">
                  {(() => {
                    // Number duplicate session names so they're distinguishable
                    const nameCount = new Map<string, number>();
                    const nameIndex = new Map<string, number>();
                    for (const s of sessionSwitcher) {
                      nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
                    }
                    return sessionSwitcher.map((session) => {
                      const count = nameCount.get(session.name) ?? 1;
                      const idx = (nameIndex.get(session.name) ?? 0) + 1;
                      nameIndex.set(session.name, idx);
                      const displayName = session.isCurrentSession
                        ? 'Q ↔ Mister'
                        : count > 1
                          ? `${compactLine(session.name, session.name, 24)} #${idx}`
                          : compactLine(session.name, session.name, 32);
                      const active = session.id === selectedSession?.id;
                      const isLive = session.status === 'running' || session.status === 'reviewing';
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={`remodex-controls-session-row ${active ? 'remodex-controls-session-row-active' : ''}`}
                          onClick={() => handleSessionFocus(session.id)}
                        >
                          <span className={`remodex-session-dot ${isLive ? 'remodex-session-dot-live' : ''}`} />
                          <span className="remodex-session-row-copy">
                            <strong>{displayName}</strong>
                            <span>{session.status} · {compactLine(session.lastEventAt, 'now', 20)}</span>
                          </span>
                          {active ? <span className="remodex-session-check">✓</span> : null}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {diffOpen ? (
        <div className="remodex-diff-overlay" role="dialog" aria-modal="true" onClick={() => setDiffOpen(false)}>
          <section className="remodex-diff-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="remodex-diff-sheet-head">
              <div className="remodex-diff-sheet-handle" />
              <h2>Changes</h2>
              <div className="remodex-sheet-head-actions">
                <button
                  type="button"
                  className="remodex-sheet-icon-button"
                  aria-label="Refresh diff"
                  onClick={() => {
                    if (selectedReviewFilePath) {
                      void loadReviewFile(selectedReviewFilePath, true);
                    } else {
                      void handleSurfaceRefresh();
                    }
                  }}
                >
                  <RefreshCw size={16} strokeWidth={2.1} className={reviewFileLoadingPath === selectedReviewFilePath ? 'spin' : undefined} />
                </button>
                <button type="button" className="remodex-done-button" onClick={() => setDiffOpen(false)}>
                  Done
                </button>
              </div>
            </div>

            {reviewFiles.length ? (
              <>
                <div className="remodex-diff-nav-row">
                  <div className="remodex-diff-position-chip">
                    {selectedReviewFilePosition ? `${selectedReviewFilePosition} of ${reviewFiles.length}` : `${reviewFiles.length} files`}
                  </div>
                  <div className="remodex-diff-nav-actions">
                    <button
                      type="button"
                      className="remodex-diff-nav-button"
                      onClick={() => jumpReviewFile('prev')}
                      disabled={!hasPrevReviewFile}
                    >
                      Prev file
                    </button>
                    <button
                      type="button"
                      className="remodex-diff-nav-button"
                      onClick={() => jumpReviewFile('next')}
                      disabled={!hasNextReviewFile}
                    >
                      Next file
                    </button>
                  </div>
                </div>
                <div className="remodex-diff-file-strip">
                  {reviewFiles.map((file) => {
                    const active = selectedReviewFilePath === file.path;
                    return (
                      <button
                        key={`${file.status}:${file.path}`}
                        type="button"
                        className={`remodex-diff-file-pill ${active ? 'remodex-diff-file-pill-active' : ''}`}
                        onClick={() => handleReviewFileFocus(file.path)}
                      >
                        {compactLine(file.path, file.path, 22)}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}

            {reviewFileError ? <p className="remodex-banner-note remodex-banner-note-sheet">{reviewFileError}</p> : null}

            <div className="remodex-diff-scroll">
              {selectedReviewFile ? (
                <>
                  <div className="remodex-diff-meta-row">
                    <div className="remodex-diff-meta-copy">
                      <strong>{selectedReviewFile.path}</strong>
                      <span className="remodex-diff-meta-position">{selectedReviewFilePosition ? `${selectedReviewFilePosition} of ${reviewFiles.length}` : `${reviewFiles.length} files`}</span>
                    </div>
                    <span>{`+${selectedReviewFile.additions ?? 0} / -${selectedReviewFile.deletions ?? 0}`}</span>
                  </div>
                  <div className="remodex-diff-block">
                    {selectedReviewFile.preview.split('\n').map((line, index) => {
                      const tone = diffLineTone(line);
                      const displayLine = tone === 'add' || tone === 'remove'
                        ? line.slice(1)
                        : tone === 'context'
                          ? (line.startsWith(' ') ? line.slice(1) : line)
                          : line;
                      return (
                        <div key={`${selectedReviewFile.path}:${index}`} className={`remodex-diff-line remodex-diff-line-${tone}`}>
                          <div className="remodex-diff-gutter" />
                          <code>{displayLine || '\u00A0'}</code>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : reviewFileLoadingPath ? (
                <div className="remodex-loading-card">Loading repository diff…</div>
              ) : (
                <div className="remodex-loading-card">No diff is selected on the mobile review surface yet.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {expandedMedia ? (
        <div className="remodex-media-overlay" role="dialog" aria-modal="true" onClick={() => setExpandedMedia(null)}>
          <section className="remodex-media-lightbox" onClick={(event) => event.stopPropagation()}>
            <div className="remodex-media-lightbox-head">
              <strong>{expandedMedia.name}</strong>
              <button type="button" className="remodex-sheet-icon-button" onClick={() => setExpandedMedia(null)} aria-label="Close media viewer">
                <X size={16} strokeWidth={2.1} />
              </button>
            </div>
            <div className="remodex-media-lightbox-body">
              {isImageMedia(expandedMedia) ? (
                <Image
                  src={mediaHref(expandedMedia.path)}
                  alt={expandedMedia.name}
                  width={1600}
                  height={1200}
                  unoptimized
                  className="remodex-media-lightbox-image"
                />
              ) : (
                <div className="remodex-media-lightbox-file">
                  <FileText size={32} strokeWidth={2.1} />
                  <p>{expandedMedia.name}</p>
                </div>
              )}
            </div>
            <div className="remodex-media-lightbox-actions">
              <a href={mediaHref(expandedMedia.path)} target="_blank" rel="noreferrer" className="remodex-media-action-link">
                <ExternalLink size={16} strokeWidth={2.1} />
                Open
              </a>
              <a href={mediaHref(expandedMedia.path, true)} download={expandedMedia.name} className="remodex-media-action-link remodex-media-action-link-primary">
                <Download size={16} strokeWidth={2.1} />
                Save
              </a>
            </div>
          </section>
        </div>
      ) : null}

    </div>
  );
}
