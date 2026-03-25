import { Fragment, createElement, useState as useStateHook, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CodeBlock } from './CodeBlock';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import type { ProjectGroup, SessionSummary } from './types';

// ── Image helpers ──

function resolveImageSrc(src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  return `/api/panel/serve-image?path=${encodeURIComponent(src)}`;
}

function MobileChatImage({ src, alt }: { src: string; alt: string }) {
  const [lightbox, setLightbox] = useStateHook(false);
  const resolved = resolveImageSrc(src);
  return createElement(Fragment, null,
    createElement('img', {
      src: resolved,
      alt,
      onClick: () => setLightbox(true),
      style: {
        maxWidth: '100%',
        maxHeight: 300,
        borderRadius: 10,
        marginTop: 8,
        marginBottom: 8,
        cursor: 'zoom-in',
        boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        border: '1px solid rgba(0,0,0,0.06)',
        display: 'block',
      },
    }),
    lightbox && typeof document !== 'undefined'
      ? createPortal(
          createElement('div', {
            onClick: () => setLightbox(false),
            style: {
              position: 'fixed' as const,
              inset: 0,
              zIndex: 99999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.8)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              cursor: 'zoom-out',
            },
          },
            createElement('img', {
              src: resolved,
              alt,
              onClick: (e: React.MouseEvent) => e.stopPropagation(),
              style: {
                maxWidth: '95vw',
                maxHeight: '90vh',
                objectFit: 'contain' as const,
                borderRadius: 8,
                cursor: 'default',
              },
            }),
          ),
          document.body,
        )
      : null,
  );
}

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

export function pickCurrentSession(snapshot: MobileInboxSnapshot) {
  return snapshot.sessions.find((session) => session.isCurrentSession)
    ?? snapshot.sessions.find((session) => session.sessionKey === snapshot.primarySessionKey)
    ?? snapshot.sessions[0];
}

/**
 * Strip markdown syntax and return a very short "live tail" of the response.
 * Apple notification style: just enough to show activity, never a wall of text.
 */
export function formatStreamingPreview(raw: string): string {
  let text = raw;
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/^\|.*\|$/gm, '');
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  text = text.replace(/^#{1,4}\s+/gm, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^[-*_]{3,}$/gm, '');
  text = text.replace(/^[-*]\s+/gm, '');
  text = text.replace(/\n{2,}/g, '\n').trim();

  const lines = text.split('\n').filter((line) => line.trim());
  const tail = lines.slice(-2).map((line) => line.length > 80 ? `${line.slice(0, 77)}…` : line);
  const result = tail.join('\n');
  return result.length > 160 ? `${result.slice(0, 157)}…` : result;
}

export function roleLabel(role: MobileTranscriptEntry['role'], agentName?: string) {
  switch (role) {
    case 'assistant':
      return agentName ?? 'Assistant';
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

export function compactLine(text: string | null | undefined, fallback: string, max = 84) {
  const value = text?.trim() || fallback;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

export function diffLineTone(line: string) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

export function contextPressureTone(usedPercent: number) {
  if (usedPercent >= 85) return 'critical';
  if (usedPercent >= 75) return 'high';
  if (usedPercent >= 65) return 'watch';
  return 'calm';
}

export function contextTrendLabel(trend?: 'falling' | 'stable' | 'rising') {
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

export function ownedLifecycleTone(availability?: string, lastOutcome?: string) {
  if (lastOutcome === 'failed') return 'critical' as const;
  if (availability === 'running') return 'high' as const;
  if (lastOutcome === 'interrupted') return 'watch' as const;
  return 'calm' as const;
}

export function ownedLifecycleLabel(availability?: string) {
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

export function ownedOutcomeLabel(lastOutcome?: string) {
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

export function ownedReviewDispositionLabel(disposition?: RuntimeReviewPacket['reviewDisposition']) {
  return disposition === 'resolved' ? 'Resolved' : 'Watching';
}

export function ownedReviewDispositionTone(disposition?: RuntimeReviewPacket['reviewDisposition']) {
  return disposition === 'resolved' ? 'calm' : 'watch';
}

export function sessionStatusSummary(
  selectedSession: SessionSummary | undefined,
  selectedReviewPacket: RuntimeReviewPacket | null | undefined,
  isOwnedCodexSession: boolean,
) {
  const contextUsedPercent = Math.round(selectedSession?.context.usedPercent ?? 0);
  const ownedAvailability = selectedSession?.runtimeSurface?.lifecycle?.availability;
  const ownedLastOutcome = selectedSession?.runtimeSurface?.lifecycle?.lastOutcome;
  const ownedReviewDisposition = selectedReviewPacket?.reviewDisposition;

  return {
    tone: isOwnedCodexSession
      ? ownedLifecycleTone(ownedAvailability, ownedLastOutcome)
      : contextPressureTone(contextUsedPercent),
    headline: isOwnedCodexSession ? ownedLifecycleLabel(ownedAvailability) : `${contextUsedPercent}% used`,
    meta: isOwnedCodexSession
      ? [ownedOutcomeLabel(ownedLastOutcome), ownedReviewDispositionLabel(ownedReviewDisposition)].join(' • ')
      : contextTrendLabel(selectedSession?.context.trend),
  };
}

export function threadLaneLabel(session: SessionSummary) {
  if (session.isCurrentSession) return 'Assistant';
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned') return 'Codex';
  if (session.runtime === 'claude-code') return 'Claude Code';
  return session.runtime === 'openclaw' ? 'OpenClaw' : 'Session';
}

export function threadLaneState(session: SessionSummary) {
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned') {
    const availability = session.runtimeSurface?.lifecycle?.availability;
    if (availability === 'running') return 'live';
    if (session.runtimeSurface?.capabilities.sendInput) return 'chat';
    return 'watch';
  }

  if (session.isCurrentSession) return 'live';
  return session.status;
}

export function buildOwnedCorrectionDraft(packet: RuntimeReviewPacket) {
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

export function mediaHref(path: string, download = false) {
  const params = new URLSearchParams({ path });
  if (download) {
    params.set('download', '1');
  }
  return `/api/mobile/media?${params.toString()}`;
}

export function isImageMedia(media: MobileTranscriptMedia) {
  return media.kind === 'image';
}

export async function fileToDataUrl(file: File) {
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

export function pushPlainInline(nodes: ReactNode[], text: string, keyPrefix: string) {
  if (!text) {
    return;
  }

  text.split('\n').forEach((part, index) => {
    if (index > 0) {
      nodes.push(createElement('br', { key: `${keyPrefix}-br-${index}` }));
    }
    if (part) {
      nodes.push(createElement(Fragment, { key: `${keyPrefix}-text-${index}` }, part));
    }
  });
}

export function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  // Check for inline images first
  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  if (imgRegex.test(text)) {
    const nodes: ReactNode[] = [];
    let lastIdx = 0;
    let mIdx = 0;
    imgRegex.lastIndex = 0;
    let match;
    while ((match = imgRegex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        nodes.push(...renderInlineMarkdownInner(text.slice(lastIdx, match.index), `${keyPrefix}-pre-${mIdx}`));
      }
      nodes.push(createElement(MobileChatImage, {
        key: `${keyPrefix}-iimg-${mIdx}`,
        alt: match[1],
        src: match[2],
      }));
      lastIdx = match.index + match[0].length;
      mIdx++;
    }
    if (lastIdx < text.length) {
      nodes.push(...renderInlineMarkdownInner(text.slice(lastIdx), `${keyPrefix}-post`));
    }
    return nodes;
  }
  return renderInlineMarkdownInner(text, keyPrefix);
}

function renderInlineMarkdownInner(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*][\s\S]*?\*\*|`[^`]+`|\*[^*][\s\S]*?\*)/g;
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(tokenRegex)) {
    const token = match[0];
    const start = match.index ?? 0;
    pushPlainInline(nodes, text.slice(lastIndex, start), `${keyPrefix}-${matchIndex}-plain`);

    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(createElement(
        'strong',
        { key: `${keyPrefix}-${matchIndex}-strong` },
        renderInlineMarkdown(token.slice(2, -2), `${keyPrefix}-${matchIndex}-strong-inner`),
      ));
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(createElement(
        'em',
        { key: `${keyPrefix}-${matchIndex}-em` },
        renderInlineMarkdown(token.slice(1, -1), `${keyPrefix}-${matchIndex}-em-inner`),
      ));
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(createElement('code', { key: `${keyPrefix}-${matchIndex}-code` }, token.slice(1, -1)));
    } else {
      pushPlainInline(nodes, token, `${keyPrefix}-${matchIndex}-fallback`);
    }

    lastIndex = start + token.length;
    matchIndex += 1;
  }

  pushPlainInline(nodes, text.slice(lastIndex), `${keyPrefix}-tail`);
  return nodes;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(trimmed);
}

function parseTableCells(line: string): string[] {
  return line.trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseTableAlignment(separatorLine: string): Array<'left' | 'center' | 'right'> {
  return parseTableCells(separatorLine).map((cell) => {
    const trimmed = cell.replace(/\s/g, '');
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
    if (trimmed.endsWith(':')) return 'right';
    return 'left';
  });
}

export function renderMessageBody(text: string, keyPrefix: string) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let paragraphLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];
  let tableLines: string[] = [];
  let inCodeFence = false;
  let codeFenceLines: string[] = [];
  let codeFenceLang = '';

  const flushTable = () => {
    if (tableLines.length < 2) {
      // Not enough lines for a real table — dump as paragraphs
      for (const tl of tableLines) paragraphLines.push(tl);
      tableLines = [];
      return;
    }

    // Determine if line 1 is a separator (header row + separator)
    const hasSeparator = tableLines.length >= 2 && isTableSeparator(tableLines[1]);
    const headerCells = parseTableCells(tableLines[0]);
    const alignments = hasSeparator ? parseTableAlignment(tableLines[1]) : headerCells.map(() => 'left' as const);
    const bodyStartIndex = hasSeparator ? 2 : 1;
    const bodyRows = tableLines.slice(bodyStartIndex).filter((l) => !isTableSeparator(l));

    const tableKey = `${keyPrefix}-tbl-${blocks.length}`;

    const headerRow = createElement('tr', { key: `${tableKey}-hdr` },
      headerCells.map((cell, ci) => createElement('th', {
        key: `${tableKey}-th-${ci}`,
        style: {
          textAlign: alignments[ci] ?? 'left',
          padding: '10px 14px',
          fontSize: '0.8rem',
          fontWeight: 600,
          color: '#6b7280',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.04em',
          borderBottom: '2px solid #e5e7eb',
          whiteSpace: 'nowrap' as const,
        },
      }, renderInlineMarkdown(cell, `${tableKey}-th-${ci}`))),
    );

    const bodyRowElements = bodyRows.map((row, ri) => {
      const cells = parseTableCells(row);
      return createElement('tr', {
        key: `${tableKey}-tr-${ri}`,
        style: {
          backgroundColor: ri % 2 === 0 ? '#ffffff' : '#f9fafb',
        },
      },
        cells.map((cell, ci) => createElement('td', {
          key: `${tableKey}-td-${ri}-${ci}`,
          style: {
            textAlign: alignments[ci] ?? 'left',
            padding: '10px 14px',
            fontSize: '0.85rem',
            color: '#1f2937',
            borderBottom: '1px solid #f3f4f6',
          },
        }, renderInlineMarkdown(cell, `${tableKey}-td-${ri}-${ci}`))),
      );
    });

    blocks.push(createElement('div', {
      key: tableKey,
      style: {
        overflowX: 'auto' as const,
        margin: '12px 0',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        backgroundColor: '#ffffff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      },
    },
      createElement('table', {
        style: {
          width: '100%',
          borderCollapse: 'collapse' as const,
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        },
      },
        createElement('thead', null, headerRow),
        createElement('tbody', null, bodyRowElements),
      ),
    ));

    tableLines = [];
  };

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    const paragraph = paragraphLines.join('\n').trim();
    if (paragraph) {
      blocks.push(createElement(
        'p',
        {
          key: `${keyPrefix}-p-${blocks.length}`,
          className: 'remodex-rich-paragraph',
        },
        renderInlineMarkdown(paragraph, `${keyPrefix}-p-${blocks.length}`),
      ));
    }
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) {
      listType = null;
      listItems = [];
      return;
    }

    const listKey = `${keyPrefix}-${listType}-${blocks.length}`;
    const items = listItems.map((item, index) => createElement(
      'li',
      { key: `${listKey}-${index}` },
      renderInlineMarkdown(item, `${listKey}-${index}`),
    ));

    blocks.push(createElement(
      listType,
      {
        key: listKey,
        className: 'remodex-rich-list',
      },
      items,
    ));

    listType = null;
    listItems = [];
  };

  // Pre-pass: detect tool output chunks and wrap them as fenced code
  // Pattern: "Chunk ID: XXXX Wall time: ... Output: ..." blocks
  const processedLines: string[] = [];
  let toolChunkLines: string[] = [];
  let inToolChunk = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const isChunkStart = /^Chunk ID:\s*[a-f0-9]+\s+Wall time:/i.test(trimmed);
    const isOutputLine = /^\[?\{"type"/.test(trimmed) || /^Output:/.test(trimmed);

    if (isChunkStart) {
      // If we were already in a chunk, flush previous
      if (inToolChunk && toolChunkLines.length > 0) {
        processedLines.push('```tool-output');
        processedLines.push(...toolChunkLines);
        processedLines.push('```');
      }
      inToolChunk = true;
      toolChunkLines = [rawLine];
      continue;
    }

    if (inToolChunk) {
      // Keep accumulating until we hit an empty line or a non-continuation line
      if (!trimmed || (trimmed.length > 0 && !isOutputLine && !trimmed.startsWith('"') && !trimmed.startsWith('[') && !trimmed.startsWith('{') && !trimmed.includes('token count') && !trimmed.includes('exited with') && !trimmed.includes('Process') && !trimmed.includes('Output:') && !trimmed.startsWith('src/') && !trimmed.startsWith('import ') && !trimmed.startsWith('page.') && !trimmed.startsWith('await ') && !/^[A-Z].*:/.test(trimmed.split(' ')[0] ?? ''))) {
        processedLines.push('```tool-output');
        processedLines.push(...toolChunkLines);
        processedLines.push('```');
        inToolChunk = false;
        toolChunkLines = [];
        if (trimmed) processedLines.push(rawLine);
      } else {
        toolChunkLines.push(rawLine);
      }
      continue;
    }

    processedLines.push(rawLine);
  }

  // Flush any remaining tool chunk
  if (inToolChunk && toolChunkLines.length > 0) {
    processedLines.push('```tool-output');
    processedLines.push(...toolChunkLines);
    processedLines.push('```');
  }

  for (const rawLine of processedLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // Code fence handling — accumulate lines between ``` markers
    if (trimmed.startsWith('```')) {
      if (inCodeFence) {
        // Closing fence — flush the code block
        const code = codeFenceLines.join('\n');
        const codeKey = `${keyPrefix}-code-${blocks.length}`;
        blocks.push(createElement(CodeBlock, {
          key: codeKey,
          code,
          language: codeFenceLang || undefined,
        }));
        inCodeFence = false;
        codeFenceLines = [];
        codeFenceLang = '';
        continue;
      }
      // Opening fence
      flushParagraph();
      flushList();
      if (tableLines.length > 0) flushTable();
      inCodeFence = true;
      codeFenceLang = trimmed.slice(3).trim();
      continue;
    }

    if (inCodeFence) {
      codeFenceLines.push(rawLine);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);

    // Table row detection — accumulate consecutive | lines
    if (isTableRow(trimmed)) {
      flushParagraph();
      flushList();
      tableLines.push(trimmed);
      continue;
    }

    // If we were accumulating table lines and hit a non-table line, flush
    if (tableLines.length > 0) {
      flushTable();
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push(createElement(
        'p',
        {
          key: `${keyPrefix}-h-${blocks.length}`,
          className: `remodex-rich-heading remodex-rich-heading-${Math.min(headingMatch[1].length, 3)}`,
        },
        renderInlineMarkdown(headingMatch[2], `${keyPrefix}-h-${blocks.length}`),
      ));
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

    // Block-level images: ![alt](url) on its own line
    const blockImgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (blockImgMatch) {
      flushParagraph();
      flushList();
      blocks.push(createElement(MobileChatImage, {
        key: `${keyPrefix}-img-${blocks.length}`,
        alt: blockImgMatch[1],
        src: blockImgMatch[2],
      }));
      continue;
    }

    // Bare image file paths on their own line
    if (trimmed.startsWith('/') && IMAGE_EXTENSIONS.test(trimmed) && !trimmed.includes(' ')) {
      flushParagraph();
      flushList();
      blocks.push(createElement(MobileChatImage, {
        key: `${keyPrefix}-img-${blocks.length}`,
        alt: trimmed.split('/').pop() ?? 'image',
        src: trimmed,
      }));
      continue;
    }

    // MEDIA: lines
    if (trimmed.startsWith('MEDIA:')) {
      flushParagraph();
      flushList();
      const mediaPath = trimmed.slice(6).trim();
      if (mediaPath) {
        blocks.push(createElement(MobileChatImage, {
          key: `${keyPrefix}-media-${blocks.length}`,
          alt: 'Generated image',
          src: mediaPath,
        }));
      }
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushTable();
  flushParagraph();
  flushList();

  return createElement('div', { className: 'remodex-rich-text' }, blocks);
}

export async function readJson<T>(response: Response) {
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

export function agentDisplayName(session: SessionSummary): string {
  if (session.isCurrentSession) return 'Assistant';
  if (session.runtime === 'codex') return 'Codex';
  const name = session.name || '';
  if (name.startsWith('Hawk')) return 'Hawk';
  if (name.startsWith('Niot')) return 'Niot';
  if (name.includes('automation') || name.includes('cron')) return 'Cron';
  if (name.includes('Telegram')) return 'Telegram';
  if (name.includes('Discord')) return 'Discord';
  if (name.includes('Assistant')) return 'Assistant';
  return name.split(/[\s·•/]/)[0] || 'Agent';
}

export function sessionRuntimePid(session: SessionSummary): string | null {
  const sourceLabel = session.runtimeSurface?.sourceLabel ?? '';
  const match = sourceLabel.match(/\b(?:live|active) pid\s+(\d+)/i);
  return match?.[1] ?? null;
}

export function mobileSessionSecondaryLabel(session: SessionSummary): string {
  const branchShort = session.branch?.replace(/^(feat|fix|batch|chore|refactor)\//, '') ?? '';
  const pid = sessionRuntimePid(session);

  if (session.runtime === 'codex') {
    const ownership = session.runtimeSurface?.ownership ?? '';
    const availability = session.runtimeSurface?.lifecycle?.availability ?? '';
    if (ownership === 'discovered' && pid) return `live pid ${pid}`;
    if (ownership === 'owned' && pid) return `owned pid ${pid}`;
    if (ownership === 'owned' && availability === 'ready-for-resume') return 'resume ready';
    if (ownership === 'owned' && availability === 'running') return 'owned live';
    return branchShort || session.status;
  }

  if (session.runtime === 'claude-code') {
    return pid ? `pid ${pid}` : branchShort || session.status;
  }

  return session.activity?.headline ?? (branchShort || session.status);
}

function projectSessionPriority(session: SessionSummary, selectedSession?: SessionSummary): number {
  if (session.sessionKey === selectedSession?.sessionKey) return 1000;
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'discovered' && session.status === 'running') return 960;
  if (session.runtime === 'claude-code' && session.status === 'running') return 940;
  if (session.isCurrentSession) return 920;
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned' && session.status === 'running') return 900;
  if (session.status === 'running') return 860;
  if (session.status === 'reviewing') return 820;
  if (session.runtime === 'codex' && session.runtimeSurface?.ownership === 'owned') return 780;
  if (session.status === 'waiting') return 740;
  if (session.status === 'failed') return 700;
  return 500;
}

export function projectDisplayName(workspace: string, sessions: SessionSummary[]): string {
  if (sessions.length === 1 && sessions[0]?.runtime !== 'openclaw') {
    const label = sessions[0]?.name?.trim();
    if (label) return label;
  }
  if (workspace.includes('workspace-ace')) return 'Niot';
  if (workspace.includes('workspace-hawk')) return 'Hawk';
  const segments = workspace.replace(/^~\//, '').split('/');
  const last = segments[segments.length - 1] || segments[0] || 'workspace';
  if (last === 'clawd' && sessions.some((session) => session.isCurrentSession)) return 'Main';
  return last;
}

export function projectSummary(sessions: SessionSummary[]): string {
  const runtimeCounts = new Map<string, number>();
  let runningCount = 0;
  for (const session of sessions) {
    const label = session.runtime === 'codex' ? 'Codex' : session.runtime === 'claude-code' ? 'Claude Code' : 'OpenClaw';
    runtimeCounts.set(label, (runtimeCounts.get(label) ?? 0) + 1);
    if (session.status === 'running' || session.status === 'reviewing') {
      runningCount += 1;
    }
  }
  const parts: string[] = [];
  for (const [label, count] of runtimeCounts) {
    parts.push(`${count} ${label}`);
  }
  if (runningCount > 0) {
    parts.push(`${runningCount} active`);
  }
  return parts.join(' · ');
}

export function buildProjectGroups(
  snapshot: MobileInboxSnapshot,
  selectedSession: SessionSummary | undefined,
): ProjectGroup[] {
  const isRelevant = (session: SessionSummary) => {
    if (session.isCurrentSession) return true;
    if (session.id === selectedSession?.id) return true;

    const ageText = session.lastEventAt ?? '';
    const hoursMatch = ageText.match(/^(\d+)h/);
    const daysMatch = ageText.match(/^(\d+)d/);
    const ageHours = daysMatch ? parseInt(daysMatch[1], 10) * 24 : hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
    const isStale = ageHours > 4;

    if (session.runtime === 'claude-code') {
      // Claude Code sessions are already filtered to live PIDs by fleet
      return session.status === 'running';
    }

    if (session.runtime === 'codex') {
      const sourceLabel = (session.runtimeSurface?.sourceLabel ?? '').toLowerCase();
      const ownership = session.runtimeSurface?.ownership ?? '';
      if (ownership === 'discovered') {
        return session.status === 'running'
          || session.status === 'reviewing'
          || sourceLabel.includes('live pid');
      }
      if (ownership === 'owned') {
        return session.status === 'running'
          || session.status === 'reviewing'
          || session.status === 'waiting'
          || session.status === 'failed'
          || sourceLabel.includes('active pid')
          || sourceLabel.includes('ready for resume')
          || sourceLabel.includes('last finished');
      }
      return session.status === 'running'
        || session.status === 'reviewing'
        || session.status === 'waiting'
        || session.status === 'failed';
    }

    if (isStale) return false;
    if (['running', 'reviewing', 'blocked'].includes(session.status)) return true;
    if (session.activity || session.alerts > 0) return true;
    return false;
  };

  const relevant = snapshot.sessions.filter(isRelevant);
  const groupMap = new Map<string, SessionSummary[]>();
  for (const session of relevant) {
    const workspace = session.workspace || '~/clawd';
    const existing = groupMap.get(workspace) ?? [];
    existing.push(session);
    groupMap.set(workspace, existing);
  }

  const groups: ProjectGroup[] = [];
  for (const [workspace, rawSessions] of groupMap) {
    const dedupedSessions: SessionSummary[] = [];
    const seenIds = new Set<string>();
    for (const session of rawSessions) {
      if (seenIds.has(session.sessionKey)) continue;
      seenIds.add(session.sessionKey);
      dedupedSessions.push(session);
    }
    const originalOrder = new Map(dedupedSessions.map((session, index) => [session.sessionKey, index]));
    const sessions = [...dedupedSessions].sort((left, right) => {
      const priorityDiff = projectSessionPriority(right, selectedSession) - projectSessionPriority(left, selectedSession);
      if (priorityDiff !== 0) return priorityDiff;
      return (originalOrder.get(left.sessionKey) ?? 0) - (originalOrder.get(right.sessionKey) ?? 0);
    });

    const hasRunning = sessions.some((session) => session.status === 'running' || session.status === 'reviewing');
    const bestContextPct = Math.max(...sessions.map((session) => session.context?.usedPercent ?? 0));
    let mostRecentTime: string | undefined;
    for (const session of sessions) {
      if (session.activity?.headline || session.lastEventAt) {
        mostRecentTime = session.lastEventAt;
        break;
      }
    }

    groups.push({
      projectName: projectDisplayName(workspace, sessions),
      workspace,
      sessions,
      hasPrimary: sessions.some((session) => session.isCurrentSession),
      summary: projectSummary(sessions),
      mostRecentTime: mostRecentTime ?? sessions[0]?.lastEventAt,
      bestContextPct,
      hasRunning,
    });
  }

  groups.sort((left, right) => {
    if (left.hasPrimary && !right.hasPrimary) return -1;
    if (!left.hasPrimary && right.hasPrimary) return 1;
    if (left.hasRunning && !right.hasRunning) return -1;
    if (!left.hasRunning && right.hasRunning) return 1;
    return 0;
  });

  return groups;
}
