'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, FileText, Image as ImageIcon } from 'lucide-react';
import type { MobileTranscriptMedia, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { ChatViewProps } from './types';
import { CodeBlock } from './CodeBlock';
import { MediaLightbox } from './MediaLightbox';
import { useTheme } from './ThemeContext';
import {
  diffLineTone,
  formatStreamingPreview,
  isImageMedia,
  mediaHref,
} from './utils';
import { isSlashCommandText } from '@/lib/slash-commands';
import { FONTS, LINE_HEIGHTS, measureHeight, useStreamingHeight } from '@/lib/pretext';

interface MessageBubbleProps {
  entry: ChatViewProps['transcriptEntries'][number];
  isLatest: boolean;
  isNewMessage: boolean;
  isExpanded: boolean;
  selectedReviewFile: ChatViewProps['selectedReviewFile'];
  renderMessageBody: ChatViewProps['renderMessageBody'];
  setExpandedMedia: ChatViewProps['setExpandedMedia'];
  onOpenDiff: ChatViewProps['onOpenDiff'];
  onToggleExpanded: (id: string) => void;
}

interface BodyElementProps {
  children?: ReactNode;
  code?: string;
  language?: string;
  style?: CSSProperties;
}

const MOBILE_CODE_FONT_FAMILY = '"SF Mono", Menlo, ui-monospace, monospace';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function useChatPalette() {
  const { colors } = useTheme();

  return useMemo(() => ({
    background: colors.bg,
    userBubble: colors.blueAccent,
    userText: '#FFFFFF',
    assistantBubble: 'rgba(44,44,46,0.9)',
    assistantText: colors.text,
    secondaryText: colors.textSecondary,
    tertiaryText: colors.textTertiary,
    toolRowBg: 'rgba(28,28,30,0.6)',
    toolRowBorder: 'rgba(255,255,255,0.08)',
    codeBlockBg: 'rgba(28,28,30,1.0)',
    codeInlineBg: 'rgba(255,255,255,0.10)',
    mutedBorder: colors.border,
    mutedSurface: 'rgba(28,28,30,0.82)',
    elevatedShadow: '0 18px 38px rgba(0, 0, 0, 0.34)',
    green: colors.green,
    red: colors.red,
  }), [colors]);
}

type ChatPalette = ReturnType<typeof useChatPalette>;

function toolDetail(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const detail = [
    typeof args.file_path === 'string' ? args.file_path : null,
    typeof args.path === 'string' ? args.path : null,
    typeof args.command === 'string' ? args.command : null,
    typeof args.cmd === 'string' ? args.cmd : null,
    typeof args.query === 'string' ? args.query : null,
    typeof args.url === 'string' ? args.url : null,
    typeof tool.preview === 'string' ? tool.preview : null,
  ].find(Boolean);

  return typeof detail === 'string' ? detail : tool.name;
}

function humanizeToolName(name: string) {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toolStatusLabel(status?: MobileTranscriptToolCall['status']) {
  if (status === 'done') return 'Done';
  if (status === 'running') return 'Running';
  if (status === 'calling') return 'Calling';
  return 'Queued';
}

function toolStatusColor(status: MobileTranscriptToolCall['status'] | undefined, palette: ChatPalette) {
  if (status === 'done') return palette.green;
  if (status === 'running' || status === 'calling') return palette.userBubble;
  return palette.tertiaryText;
}

function formatCodeLanguage(language?: string) {
  if (!language) return 'Code';
  if (language === 'tool-output') return 'Exec Output';
  const aliases: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    py: 'Python',
    rb: 'Ruby',
    sh: 'Shell',
    bash: 'Shell',
    zsh: 'Shell',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    css: 'CSS',
    html: 'HTML',
    sql: 'SQL',
    md: 'Markdown',
    diff: 'Diff',
    rust: 'Rust',
    go: 'Go',
    mermaid: 'Mermaid',
    toml: 'TOML',
    xml: 'XML',
    graphql: 'GraphQL',
  };
  return aliases[language.toLowerCase()] ?? language;
}

function extractArtifactPreview(text: string) {
  const match = text.match(/```(?:([^\n]*))\n([\s\S]*?)```/);
  if (!match) {
    return { bodyText: text, preview: null as string | null };
  }

  const preview = match[2].trim();
  const bodyText = text.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { bodyText, preview: preview || null };
}

function buildArtifact(
  entryText: string,
  toolCalls: MobileTranscriptToolCall[] | undefined,
  selectedReviewFile: ChatViewProps['selectedReviewFile'],
  isLatest: boolean,
) {
  const fileTool = [...(toolCalls ?? [])].reverse().find((tool) => {
    const name = tool.name.toLowerCase();
    return name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file' || name === 'read' || name === 'read_file';
  });

  const { bodyText, preview } = extractArtifactPreview(entryText);
  const filePath = typeof fileTool?.args?.file_path === 'string'
    ? fileTool.args.file_path
    : typeof fileTool?.args?.path === 'string'
      ? fileTool.args.path
      : (isLatest ? selectedReviewFile?.path : null);

  const selectedPreview = isLatest ? selectedReviewFile?.preview?.trim() : '';
  const artifactPreview = preview ?? selectedPreview ?? '';

  if (!filePath || !artifactPreview) {
    return {
      artifact: null,
      bodyText: entryText,
    };
  }

  const action = (() => {
    const name = fileTool?.name.toLowerCase() ?? '';
    if (name === 'read' || name === 'read_file') return 'Read';
    if (name === 'edit' || name === 'edit_file') return 'Edit';
    return 'Write';
  })();

  return {
    artifact: {
      action,
      path: filePath,
      preview: artifactPreview,
    },
    bodyText: bodyText || entryText,
  };
}

function mergeElementStyle(style: unknown): CSSProperties {
  if (!style || typeof style !== 'object') {
    return {};
  }
  return style as CSSProperties;
}

function richTextStyleFor(
  tag: string,
  existingStyle: CSSProperties,
  palette: ChatPalette,
  tone: 'user' | 'assistant',
): CSSProperties {
  const bodyColor = tone === 'user' ? palette.userText : palette.assistantText;
  const inlineCodeBg = tone === 'user' ? 'rgba(255,255,255,0.16)' : palette.codeInlineBg;

  if (tag === 'div' && existingStyle.overflowX === 'auto') {
    return {
      overflowX: 'auto',
      margin: '10px 0 0',
      borderRadius: 10,
      border: `1px solid ${palette.toolRowBorder}`,
      background: palette.codeBlockBg,
      boxShadow: 'none',
    };
  }

  switch (tag) {
    case 'div':
      return {
        display: existingStyle.display ?? 'grid',
        gap: existingStyle.gap ?? 10,
        minWidth: existingStyle.minWidth ?? 0,
        color: bodyColor,
      };
    case 'h1':
      return {
        margin: 0,
        color: bodyColor,
        fontSize: 16,
        fontWeight: 700,
        lineHeight: 1.3,
        letterSpacing: '-0.01em',
      };
    case 'h2':
    case 'h3':
      return {
        margin: 0,
        color: bodyColor,
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1.4,
        letterSpacing: '0.01em',
      };
    case 'p':
      return {
        margin: 0,
        color: bodyColor,
        fontSize: 15,
        lineHeight: 1.48,
        whiteSpace: 'pre-wrap',
      };
    case 'ul':
    case 'ol':
      return {
        margin: 0,
        paddingLeft: 18,
        display: 'grid',
        gap: 6,
        color: bodyColor,
        fontSize: 15,
        lineHeight: 1.48,
      };
    case 'li':
      return {
        color: bodyColor,
      };
    case 'strong':
      return {
        color: bodyColor,
        fontWeight: 650,
      };
    case 'em':
      return {
        color: bodyColor,
      };
    case 'code':
      return {
        padding: '2px 6px',
        borderRadius: 6,
        background: inlineCodeBg,
        color: bodyColor,
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 13,
      };
    case 'table':
      return {
        width: '100%',
        borderCollapse: 'collapse',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      };
    case 'th':
      return {
        textAlign: existingStyle.textAlign ?? 'left',
        padding: '10px 12px',
        color: palette.secondaryText,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        borderBottom: `1px solid ${palette.toolRowBorder}`,
        whiteSpace: 'nowrap',
      };
    case 'td':
      return {
        textAlign: existingStyle.textAlign ?? 'left',
        padding: '10px 12px',
        color: bodyColor,
        fontSize: 13,
        borderBottom: `1px solid rgba(255,255,255,0.06)`,
      };
    case 'tr':
      return {
        background: existingStyle.backgroundColor ? 'rgba(255,255,255,0.02)' : undefined,
      };
    default:
      return {};
  }
}

function restyleMessageBodyNode(
  node: ReactNode,
  palette: ChatPalette,
  tone: 'user' | 'assistant',
): ReactNode {
  if (Array.isArray(node)) {
    return node.map((child) => restyleMessageBodyNode(child, palette, tone));
  }

  if (!isValidElement<BodyElementProps>(node)) {
    return node;
  }

  if (node.type === CodeBlock) {
    const { code = '', language } = node.props;
    return <PremiumCodeBlock key={node.key ?? undefined} code={code} language={language} />;
  }

  const children = node.props.children == null
    ? node.props.children
    : Children.map(node.props.children, (child) => restyleMessageBodyNode(child, palette, tone));

  if (typeof node.type === 'string') {
    const existingStyle = mergeElementStyle(node.props.style);
    const style = {
      ...richTextStyleFor(node.type, existingStyle, palette, tone),
      ...existingStyle,
    };

    return cloneElement(node, {
      ...node.props,
      style,
    }, children);
  }

  return cloneElement(node, { ...node.props }, children);
}

function renderStyledMessageBody(
  renderMessageBody: ChatViewProps['renderMessageBody'],
  text: string,
  keyPrefix: string,
  palette: ChatPalette,
  tone: 'user' | 'assistant',
) {
  return restyleMessageBodyNode(renderMessageBody(text, keyPrefix), palette, tone);
}

const PremiumCodeBlock = memo(function PremiumCodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const palette = useChatPalette();
  const isMermaid = language?.toLowerCase() === 'mermaid';
  const [expanded, setExpanded] = useState(isMermaid);

  if (isMermaid) {
    return <CodeBlock code={code} language={language} />;
  }

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
    padding: '10px 12px 8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: palette.secondaryText,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    ...({ WebkitTapHighlightColor: 'transparent' } as CSSProperties),
  } satisfies CSSProperties;

  const preStyle = {
    margin: 0,
    padding: 12,
    background: palette.codeBlockBg,
    color: palette.assistantText,
    font: FONTS.monoBlock,
    fontFamily: MOBILE_CODE_FONT_FAMILY,
    fontSize: 13,
    lineHeight: LINE_HEIGHTS.monoBlock,
    whiteSpace: 'pre',
    overflowX: 'auto',
    borderTop: `1px solid ${palette.toolRowBorder}`,
    ...({ WebkitOverflowScrolling: 'touch' } as CSSProperties),
  } satisfies CSSProperties;

  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 10,
        overflow: 'hidden',
        background: palette.codeBlockBg,
        border: `1px solid ${palette.toolRowBorder}`,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={headerStyle}
      >
        <span>{formatCodeLanguage(language)}</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: palette.tertiaryText,
          }}
        >
          <span style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>{code.split('\n').length} lines</span>
          <ChevronDown
            size={14}
            strokeWidth={2}
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms ease' }}
          />
        </span>
      </button>
      {expanded ? (
        <pre style={preStyle}>
          <code>{code}</code>
        </pre>
      ) : null}
    </div>
  );
});

const ArtifactPreviewCard = memo(function ArtifactPreviewCard({
  action,
  path,
  preview,
}: {
  action: string;
  path: string;
  preview: string;
}) {
  const palette = useChatPalette();
  const previewLines = preview.split('\n').filter(Boolean).slice(0, 10);

  if (!previewLines.length) {
    return null;
  }

  return (
    <div
      style={{
        overflow: 'hidden',
        borderRadius: 10,
        border: `1px solid ${palette.toolRowBorder}`,
        background: palette.toolRowBg,
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 6,
          padding: '10px 12px',
          borderBottom: `1px solid ${palette.toolRowBorder}`,
        }}
      >
        <span
          style={{
            color: palette.secondaryText,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {action}
        </span>
        <code
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '6px 8px',
            borderRadius: 8,
            background: palette.codeBlockBg,
            color: palette.assistantText,
            fontFamily: '"SF Mono", Menlo, monospace',
            fontSize: 12,
          }}
        >
          {path}
        </code>
      </div>
      <div style={{ display: 'grid' }}>
        {previewLines.map((line, index) => {
          const tone = diffLineTone(line);
          const rowBackground = tone === 'add'
            ? 'rgba(48,209,88,0.10)'
            : tone === 'remove'
              ? 'rgba(255,69,58,0.10)'
              : tone === 'meta' || tone === 'hunk'
                ? 'rgba(10,132,255,0.10)'
                : 'transparent';
          const rowColor = tone === 'add'
            ? palette.green
            : tone === 'remove'
              ? palette.red
              : tone === 'meta' || tone === 'hunk'
                ? '#7CC3FF'
                : palette.assistantText;

          return (
            <div
              key={`${path}-${index}`}
              style={{
                padding: '4px 12px',
                background: rowBackground,
              }}
            >
              <code
                style={{
                  display: 'block',
                  color: rowColor,
                  fontFamily: '"SF Mono", Menlo, monospace',
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {line}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const MessageBubble = memo(function MessageBubble({
  entry,
  isLatest,
  isNewMessage,
  isExpanded,
  selectedReviewFile,
  renderMessageBody,
  setExpandedMedia,
  onOpenDiff,
  onToggleExpanded,
}: MessageBubbleProps) {
  const palette = useChatPalette();
  const isUser = entry.role === 'user';
  const hasText = Boolean(entry.text.trim());
  const hasMedia = Boolean(entry.media?.length);
  const bubbleAnimation = isNewMessage ? 'chatview-message-fade-in 220ms ease-out' : undefined;

  if (isUser) {
    const isSlashCommand = isSlashCommandText(entry.text);
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          width: '100%',
          animation: bubbleAnimation,
        }}
      >
        {hasMedia ? (
          <MediaGrid
            media={entry.media ?? []}
            setExpandedMedia={setExpandedMedia}
            align="right"
            maxWidth="80%"
          />
        ) : null}
        {hasText ? (
          <div
            style={{
              width: 'fit-content',
              maxWidth: '80%',
              padding: '10px 14px',
              borderRadius: 14,
              background: palette.userBubble,
              color: palette.userText,
              boxShadow: palette.elevatedShadow,
            }}
          >
            {isSlashCommand ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'rgba(255,255,255,0.72)',
                  }}
                >
                  Slash Command
                </span>
              </div>
            ) : null}
            <div style={isSlashCommand ? { fontFamily: '"SF Mono", Menlo, monospace', fontSize: 14 } : undefined}>
              {renderStyledMessageBody(renderMessageBody, entry.text, `${entry.id}-user`, palette, 'user')}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const isCompaction = entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));

  if (isCompaction) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 999,
          background: 'rgba(28,28,30,0.72)',
          color: palette.secondaryText,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.01em',
          animation: bubbleAnimation,
        }}
      >
        <span aria-hidden="true">⟳</span>
        <span>Context compacted</span>
        {entry.timestampLabel ? (
          <span style={{ color: palette.tertiaryText, fontSize: 11 }}>
            {entry.timestampLabel}
          </span>
        ) : null}
      </div>
    );
  }

  const artifactData = buildArtifact(entry.text, entry.toolCalls, selectedReviewFile, isLatest);

  return (
    <article
      style={{
        display: 'grid',
        gap: 8,
        width: 'fit-content',
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 14,
        background: palette.assistantBubble,
        color: palette.assistantText,
        boxShadow: palette.elevatedShadow,
        animation: bubbleAnimation,
      }}
    >
      {entry.toolCalls?.length ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {entry.toolCalls.map((tool, index) => {
            const statusColor = toolStatusColor(tool.status, palette);
            return (
              <button
                key={`${entry.id}-${tool.name}-${index}`}
                type="button"
                onClick={() => onToggleExpanded(entry.id)}
                aria-expanded={isExpanded}
                style={{
                  display: 'grid',
                  gap: isExpanded ? 8 : 0,
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${palette.toolRowBorder}`,
                  background: palette.toolRowBg,
                  color: palette.assistantText,
                  cursor: 'pointer',
                  textAlign: 'left',
                  ...({ WebkitTapHighlightColor: 'transparent' } as CSSProperties),
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: statusColor,
                        flexShrink: 0,
                        animation: tool.status === 'running' || tool.status === 'calling'
                          ? 'chatview-thinking-pulse 1.4s ease-in-out infinite'
                          : undefined,
                      }}
                    />
                    <span
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      {humanizeToolName(tool.name)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: palette.secondaryText,
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontSize: 11 }}>{toolStatusLabel(tool.status)}</span>
                    <ChevronDown
                      size={14}
                      strokeWidth={2}
                      style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms ease' }}
                    />
                  </div>
                </div>
                {isExpanded ? (
                  <code
                    style={{
                      display: 'block',
                      color: palette.secondaryText,
                      fontFamily: '"SF Mono", Menlo, monospace',
                      fontSize: 12,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {toolDetail(tool)}
                  </code>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {hasMedia ? (
        <MediaGrid
          media={entry.media ?? []}
          setExpandedMedia={setExpandedMedia}
          align="left"
          maxWidth="100%"
        />
      ) : null}

      {artifactData.bodyText.trim()
        ? renderStyledMessageBody(renderMessageBody, artifactData.bodyText, `${entry.id}-assistant`, palette, 'assistant')
        : null}

      {artifactData.artifact ? (
        <div
          role={isLatest && selectedReviewFile ? 'button' : undefined}
          tabIndex={isLatest && selectedReviewFile ? 0 : undefined}
          onClick={isLatest && selectedReviewFile ? onOpenDiff : undefined}
          onKeyDown={isLatest && selectedReviewFile ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpenDiff();
            }
          } : undefined}
          style={{
            cursor: isLatest && selectedReviewFile ? 'pointer' : 'default',
            outline: 'none',
          }}
        >
          <ArtifactPreviewCard
            action={artifactData.artifact.action}
            path={artifactData.artifact.path}
            preview={artifactData.artifact.preview}
          />
        </div>
      ) : null}
    </article>
  );
});

function MediaGrid({
  media,
  setExpandedMedia,
  align = 'left',
  maxWidth = '100%',
}: {
  media: MobileTranscriptMedia[];
  setExpandedMedia: (media: MobileTranscriptMedia | null) => void;
  align?: 'left' | 'right';
  maxWidth?: CSSProperties['maxWidth'];
}) {
  const palette = useChatPalette();
  const images = media.filter(isImageMedia);
  const files = media.filter((item) => !isImageMedia(item));
  const imgCount = images.length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        maxWidth,
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      {imgCount > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: imgCount === 1 ? '1fr' : '1fr 1fr',
            gap: 2,
            borderRadius: 14,
            overflow: 'hidden',
            width: '100%',
            background: palette.codeBlockBg,
          }}
        >
          {images.map((item, index) => {
            const span = imgCount === 3 && index === 0;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => setExpandedMedia(item)}
                style={{
                  gridColumn: span ? '1 / -1' : undefined,
                  margin: 0,
                  padding: 0,
                  border: 'none',
                  background: palette.codeBlockBg,
                  cursor: 'pointer',
                  display: 'block',
                  overflow: 'hidden',
                  lineHeight: 0,
                  ...({ WebkitTapHighlightColor: 'transparent' } as CSSProperties),
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaHref(item.path)}
                  alt={item.name}
                  loading="lazy"
                  style={{
                    width: '100%',
                    height: imgCount === 1 ? 'auto' : 160,
                    maxHeight: imgCount === 1 ? 400 : undefined,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      {files.map((item) => (
        <div
          key={item.path}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            gap: 12,
            alignItems: 'center',
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${palette.toolRowBorder}`,
            background: palette.toolRowBg,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 10,
              background: palette.codeBlockBg,
              color: palette.assistantText,
            }}
          >
            {item.kind === 'pdf' ? <FileText size={18} strokeWidth={2.1} /> : <ImageIcon size={18} strokeWidth={2.1} />}
          </div>
          <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
            <strong
              style={{
                color: palette.assistantText,
                fontSize: 13,
                lineHeight: 1.35,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.name}
            </strong>
            <span style={{ color: palette.secondaryText, fontSize: 11 }}>
              {item.kind === 'pdf' ? 'PDF artifact' : 'File artifact'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <a
              href={mediaHref(item.path)}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#7CC3FF', fontSize: 12, textDecoration: 'none' }}
            >
              Open
            </a>
            <a
              href={mediaHref(item.path, true)}
              download={item.name}
              style={{ color: '#7CC3FF', fontSize: 12, textDecoration: 'none' }}
            >
              Save
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

function shouldShowTimestamp(entries: ChatViewProps['transcriptEntries'], index: number) {
  const entry = entries[index];
  if (!entry?.timestampLabel) {
    return false;
  }

  if (entry.type === 'compaction') {
    return false;
  }

  const previousEntry = index > 0 ? entries[index - 1] : null;
  if (!previousEntry) {
    return true;
  }

  if (previousEntry.role !== entry.role) {
    return true;
  }

  if (typeof previousEntry.timestamp === 'number' && typeof entry.timestamp === 'number') {
    return entry.timestamp - previousEntry.timestamp >= FIVE_MINUTES_MS;
  }

  return false;
}

export function ChatView({
  transcriptEntries,
  transcriptLoading,
  isRefreshing,
  composeHeight = 120,
  selectedSession,
  selectedReviewFile,
  streamingText,
  waitingForResponse,
  actionState,
  hydrated,
  isOwnedCodexSession,
  seenMessageIdsRef,
  agentDisplayName,
  renderMessageBody,
  expandedMedia,
  setExpandedMedia,
  onOpenDiff,
  onScrollToLatestMessage,
  onLoadMore,
  hasMoreHistory = true,
}: ChatViewProps) {
  const palette = useChatPalette();
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(hasMoreHistory);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const toggleExpanded = useCallback((id: string) => {
    setExpandedMessageId((prev) => (prev === id ? null : id));
  }, []);
  const latestVisibleEntryRef = useRef<{ sessionKey?: string; entryId: string | null }>({
    sessionKey: selectedSession?.sessionKey,
    entryId: transcriptEntries[transcriptEntries.length - 1]?.id ?? null,
  });
  const initialScrollSessionRef = useRef<string | null>(null);
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!hydrated || !seenMessageIdsRef.current || seenMessageIdsRef.current.size === 0) {
      setNewMessageIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const ids = new Set<string>();
    for (const entry of transcriptEntries) {
      if (!seenMessageIdsRef.current.has(entry.id)) {
        ids.add(entry.id);
        seenMessageIdsRef.current.add(entry.id);
      }
    }
    setNewMessageIds((prev) => (ids.size === 0 && prev.size === 0 ? prev : ids));
  }, [hydrated, transcriptEntries, seenMessageIdsRef]);

  const transcriptRef = useRef(transcriptEntries);
  useEffect(() => { transcriptRef.current = transcriptEntries; }, [transcriptEntries]);

  const containerWidthRef = useRef<number>(
    typeof window !== 'undefined' ? window.innerWidth - 32 : 300,
  );
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    containerWidthRef.current = node.clientWidth || window.innerWidth - 32;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (width > 0) containerWidthRef.current = width;
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const estimateSize = useCallback((index: number) => {
    const entry = transcriptRef.current[index];
    if (!entry) return 80;
    const text = entry.text ?? '';
    const hasMedia = Boolean(entry.media?.length);
    const mediaExtra = hasMedia ? 240 : 0;
    const codeBlocks = (text.match(/```/g) ?? []).length / 2;
    const codeExtra = Math.floor(codeBlocks) * 120;

    if (entry.role === 'system' && text.toLowerCase().includes('compaction')) return 44;

    const measuredWidth = containerWidthRef.current;
    if (measuredWidth > 0 && text) {
      const measured = measureHeight(text, 'body', measuredWidth - 48);
      const base = entry.role === 'user' ? 52 : 64;
      return Math.max(base, base + measured + codeExtra + mediaExtra);
    }

    const textLen = text.length;
    const lineBreaks = (text.match(/\n/g) ?? []).length;
    const lineHeight = lineBreaks * 22;
    if (entry.role === 'user') return Math.max(52, 52 + Math.ceil(textLen / 50) * 22 + mediaExtra);
    const charEstimate = Math.ceil(textLen / 45) * 22;
    return Math.max(80, 64 + Math.max(charEstimate, lineHeight) + codeExtra + mediaExtra);
  }, []);

  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [transcriptEntries.length]);

  const getItemKey = useCallback((index: number) => transcriptRef.current[index]?.id ?? `row-${index}`, []);
  const virtualizer = useWindowVirtualizer({
    count: transcriptEntries.length,
    estimateSize,
    getItemKey,
    overscan: 6,
    scrollMargin,
  });

  const transcriptIds = useMemo(
    () => transcriptEntries.map((entry) => entry.id),
    [transcriptEntries],
  );
  const previousVirtualStateRef = useRef<{ sessionKey?: string; ids: string[] }>({
    sessionKey: selectedSession?.sessionKey,
    ids: transcriptIds,
  });

  useEffect(() => {
    const previous = previousVirtualStateRef.current;
    const sessionChanged = previous.sessionKey !== selectedSession?.sessionKey;
    const appendedOnly = (
      !sessionChanged
      && transcriptIds.length >= previous.ids.length
      && previous.ids.every((id, index) => transcriptIds[index] === id)
    );
    const idsChanged = (
      transcriptIds.length !== previous.ids.length
      || transcriptIds.some((id, index) => previous.ids[index] !== id)
    );

    if (sessionChanged || (idsChanged && !appendedOnly)) {
      virtualizer.measure();
      setExpandedMessageId(null);
      setHasNewMessages(false);
    }

    previousVirtualStateRef.current = {
      sessionKey: selectedSession?.sessionKey,
      ids: transcriptIds,
    };
  }, [selectedSession?.sessionKey, transcriptIds, virtualizer]);

  useEffect(() => {
    if (!selectedSession?.sessionKey || transcriptEntries.length === 0) return;
    if (initialScrollSessionRef.current === selectedSession.sessionKey) return;
    initialScrollSessionRef.current = selectedSession.sessionKey;
    setHasNewMessages(false);
    requestAnimationFrame(() => onScrollToLatestMessage(true));
  }, [selectedSession?.sessionKey, transcriptEntries.length, onScrollToLatestMessage]);

  useEffect(() => {
    const handleScroll = () => {
      const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      const atBottom = distanceFromBottom < 120;
      stickToBottomRef.current = atBottom;
      if (atBottom) setHasNewMessages(false);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const latestEntry = transcriptEntries[transcriptEntries.length - 1] ?? null;
    const previous = latestVisibleEntryRef.current;
    const sessionChanged = previous.sessionKey !== selectedSession?.sessionKey;

    if (!latestEntry) {
      latestVisibleEntryRef.current = {
        sessionKey: selectedSession?.sessionKey,
        entryId: null,
      };
      return;
    }

    const latestChanged = previous.entryId !== latestEntry.id;
    if (!sessionChanged && latestChanged) {
      const shouldForceScroll = waitingForResponse || latestEntry.id.startsWith('optimistic-');
      if (shouldForceScroll || stickToBottomRef.current) {
        setHasNewMessages(false);
        requestAnimationFrame(() => onScrollToLatestMessage(shouldForceScroll));
      } else if (latestEntry.role === 'assistant') {
        setHasNewMessages(true);
      }
    }

    latestVisibleEntryRef.current = {
      sessionKey: selectedSession?.sessionKey,
      entryId: latestEntry.id,
    };
  }, [selectedSession?.sessionKey, transcriptEntries, waitingForResponse, onScrollToLatestMessage]);

  const hasEntries = transcriptEntries.length > 0;
  const virtualItems = virtualizer.getVirtualItems();

  const lastAssistantIndex = useMemo(() => {
    for (let index = transcriptEntries.length - 1; index >= 0; index -= 1) {
      if (transcriptEntries[index].role === 'assistant') return index;
    }
    return -1;
  }, [transcriptEntries]);

  const [streamingContainerWidth] = useState<number>(
    typeof window !== 'undefined' ? Math.max(window.innerWidth - 56, 200) : 300,
  );
  const streamingPreviewHeight = useStreamingHeight(
    streamingText ?? '',
    'body',
    streamingContainerWidth,
    1.4,
  );

  const loadMoreButtonStyle = {
    padding: '10px 18px',
    borderRadius: 999,
    border: `1px solid ${palette.toolRowBorder}`,
    background: palette.mutedSurface,
    color: palette.secondaryText,
    fontSize: 13,
    fontWeight: 600,
    cursor: loadingMore ? 'default' : 'pointer',
    opacity: loadingMore ? 0.5 : 1,
    touchAction: 'manipulation',
    ...({ WebkitTapHighlightColor: 'transparent' } as CSSProperties),
  } satisfies CSSProperties;

  return (
    <>
      <style>{`
        @keyframes chatview-session-fade-in {
          from { opacity: 0.4; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes chatview-message-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes chatview-thinking-pulse {
          0%, 100% { opacity: 0.42; }
          50% { opacity: 1; }
        }
        @keyframes chatview-jump-pill-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes chatview-refresh-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes chatview-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes chatview-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes chatview-compact-pulse {
          0%, 100% { transform: translateX(-30%); opacity: 0.72; }
          50% { transform: translateX(8%); opacity: 1; }
        }
      `}</style>

      <div
        ref={listRef}
        key={selectedSession?.sessionKey ?? 'none'}
        style={{
          display: 'block',
          minHeight: 0,
          paddingTop: 8,
          background: palette.background,
          animation: 'chatview-session-fade-in 0.2s ease-out',
        }}
      >
        {hasEntries && onLoadMore && canLoadMore ? (
          <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
            <button
              type="button"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                const added = await onLoadMore();
                if (added === 0) setCanLoadMore(false);
                setLoadingMore(false);
              }}
              onTouchEnd={async (event) => {
                event.preventDefault();
                if (loadingMore) return;
                setLoadingMore(true);
                const added = await (onLoadMore?.() ?? Promise.resolve(0));
                if (added === 0) setCanLoadMore(false);
                setLoadingMore(false);
              }}
              style={loadMoreButtonStyle}
            >
              {loadingMore ? 'Loading...' : 'Load earlier messages'}
            </button>
          </div>
        ) : null}

        {hasEntries ? (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const entry = transcriptEntries[virtualRow.index];
              const previousEntry = virtualRow.index > 0 ? transcriptEntries[virtualRow.index - 1] : null;
              const isLatest = virtualRow.index === lastAssistantIndex;
              const isNew = newMessageIds.has(entry.id);
              const showTimestamp = shouldShowTimestamp(transcriptEntries, virtualRow.index);
              const rowGap = previousEntry ? (previousEntry.role === entry.role ? 4 : 16) : 0;
              const rowAlign = entry.type === 'compaction'
                ? 'center'
                : entry.role === 'user'
                  ? 'flex-end'
                  : entry.role === 'system'
                    ? 'center'
                    : 'flex-start';

              return (
                <div
                  key={entry.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start - (virtualizer.options.scrollMargin ?? 0)}px)`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: rowAlign,
                      paddingTop: rowGap,
                    }}
                  >
                    {showTimestamp ? (
                      <div
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: rowAlign,
                          marginBottom: 6,
                        }}
                      >
                        <span
                          style={{
                            color: palette.tertiaryText,
                            fontSize: 11,
                            lineHeight: 1.2,
                          }}
                        >
                          {entry.timestampLabel}
                        </span>
                      </div>
                    ) : null}

                    <MessageBubble
                      entry={entry}
                      isLatest={isLatest}
                      isNewMessage={isNew}
                      isExpanded={expandedMessageId === entry.id}
                      selectedReviewFile={selectedReviewFile}
                      renderMessageBody={renderMessageBody}
                      setExpandedMedia={setExpandedMedia}
                      onOpenDiff={onOpenDiff}
                      onToggleExpanded={toggleExpanded}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : transcriptLoading ? (
          <div style={{ display: 'grid', gap: 16, paddingTop: 8 }}>
            {[
              { width: '75%', alignSelf: 'flex-start', background: 'linear-gradient(90deg, rgba(44,44,46,0.9) 25%, rgba(58,58,60,0.9) 50%, rgba(44,44,46,0.9) 75%)', height: 52 },
              { width: '55%', alignSelf: 'flex-end', background: 'linear-gradient(90deg, rgba(10,132,255,0.7) 25%, rgba(42,152,255,0.85) 50%, rgba(10,132,255,0.7) 75%)', height: 52 },
              { width: '85%', alignSelf: 'flex-start', background: 'linear-gradient(90deg, rgba(44,44,46,0.9) 25%, rgba(58,58,60,0.9) 50%, rgba(44,44,46,0.9) 75%)', height: 84 },
              { width: '40%', alignSelf: 'flex-end', background: 'linear-gradient(90deg, rgba(10,132,255,0.7) 25%, rgba(42,152,255,0.85) 50%, rgba(10,132,255,0.7) 75%)', height: 40 },
            ].map((bubble, index) => (
              <div
                key={index}
                style={{
                  width: bubble.width,
                  height: bubble.height,
                  alignSelf: bubble.alignSelf,
                  borderRadius: 14,
                  background: bubble.background,
                  backgroundSize: '200% 100%',
                  animation: 'chatview-shimmer 1.6s ease-in-out infinite',
                }}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              marginTop: 12,
              padding: '14px 16px',
              borderRadius: 14,
              background: palette.mutedSurface,
              color: palette.secondaryText,
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            {isOwnedCodexSession
              ? 'No run history yet — waiting for the first readable output.'
              : 'No transcript turns visible yet — latest activity may have been tool-heavy or compacted.'}
          </div>
        )}

        <div style={{ height: Math.max(composeHeight, 120) + 24 }} aria-hidden="true" />
      </div>

      {(() => {
        const lastEntry = transcriptEntries[transcriptEntries.length - 1];
        const isCompacting = (waitingForResponse || actionState === 'steering')
          && lastEntry
          && lastEntry.text?.toLowerCase().includes('compact');

        if (streamingText && !isCompacting) {
          return (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
              <article
                style={{
                  width: 'fit-content',
                  maxWidth: '85%',
                  display: 'grid',
                  gap: 8,
                  padding: '10px 14px',
                  borderRadius: 14,
                  background: palette.assistantBubble,
                  color: palette.assistantText,
                  boxShadow: palette.elevatedShadow,
                }}
              >
                <span
                  style={{
                    color: palette.secondaryText,
                    fontSize: 13,
                    fontWeight: 600,
                    animation: 'chatview-thinking-pulse 1.4s ease-in-out infinite',
                  }}
                >
                  Thinking...
                </span>
                <div
                  style={{
                    height: Math.min(streamingPreviewHeight || 22, 60),
                    overflow: 'hidden',
                    color: palette.assistantText,
                    fontSize: 14,
                    lineHeight: 1.4,
                    opacity: 0.9,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {formatStreamingPreview(streamingText)}
                </div>
              </article>
            </div>
          );
        }

        if (isCompacting) {
          return (
            <div
              style={{
                marginTop: 8,
                padding: '14px 16px',
                borderRadius: 14,
                background: 'rgba(28,28,30,0.86)',
                border: '1px solid rgba(255,149,0,0.18)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                ...({ WebkitBackdropFilter: 'blur(18px)', backdropFilter: 'blur(18px)' } as CSSProperties),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    border: '2px solid rgba(255,149,0,0.24)',
                    borderTopColor: '#ff9500',
                    animation: 'chatview-spin 1s linear infinite',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 14, fontWeight: 700, color: '#ffb340' }}>
                  Compacting context
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: palette.secondaryText }}>
                {selectedSession ? agentDisplayName(selectedSession) : 'Agent'} is compressing context to free up memory. Messages you send now will be queued and delivered after compaction completes.
              </p>
              <div
                style={{
                  height: 4,
                  borderRadius: 999,
                  overflow: 'hidden',
                  background: 'rgba(255,149,0,0.10)',
                }}
              >
                <div
                  style={{
                    width: '68%',
                    height: '100%',
                    borderRadius: 999,
                    background: 'linear-gradient(90deg, #ff9500, #ffd60a)',
                    animation: 'chatview-compact-pulse 1.8s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          );
        }

        if (waitingForResponse || actionState === 'steering') {
          return (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 14,
                  background: 'rgba(28,28,30,0.82)',
                  color: palette.secondaryText,
                  fontSize: 13,
                  fontWeight: 600,
                  animation: 'chatview-thinking-pulse 1.4s ease-in-out infinite',
                }}
              >
                Thinking...
              </div>
            </div>
          );
        }

        return null;
      })()}

      {hasNewMessages ? (
        <button
          type="button"
          aria-label="Jump to newest message"
          onClick={() => {
            setHasNewMessages(false);
            onScrollToLatestMessage(true);
          }}
          style={{
            position: 'fixed',
            bottom: `${composeHeight + 48}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 999,
            border: `1px solid ${palette.toolRowBorder}`,
            background: 'rgba(28,28,30,0.92)',
            color: palette.assistantText,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            animation: 'chatview-jump-pill-in 0.3s ease-out',
            ...({ WebkitBackdropFilter: 'blur(16px)', backdropFilter: 'blur(16px)' } as CSSProperties),
          }}
        >
          ↓
        </button>
      ) : null}

      {isRefreshing && transcriptEntries.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: 'linear-gradient(90deg, transparent, #0A84FF, transparent)',
            animation: 'chatview-refresh-slide 1.5s ease-in-out infinite',
            zIndex: 10,
          }}
        />
      ) : null}

      <MediaLightbox media={expandedMedia} onClose={() => setExpandedMedia(null)} />
    </>
  );
}
