'use client';

import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { codeTheme, highlightCode } from './mobile-markdown';
import { ICON_PATHS, MobilePalette, mobileFontFamily } from './mobile-approvals-shared';
type ToolVisualStatus = 'pending' | 'success' | 'error';
type ToolRenderInput = {
  toolCallId?: string;
  args?: Record<string, unknown>;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  pending?: boolean;
  light: boolean;
  palette: MobilePalette;
};
type ToolCallCardProps = {
  headerLabel: string;
  palette: MobilePalette;
  light: boolean;
  status: ToolVisualStatus;
  defaultCollapsed?: boolean;
  collapsedBody?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
};
const MONO_FONT = '"SF Mono", Menlo, monospace';
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function stringifyValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function readStringArg(args: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}
function readPreview(result: unknown) {
  if (typeof result === 'string') return result;
  if (isRecord(result)) {
    if (typeof result.preview === 'string' && result.preview.trim()) return result.preview;
    if (typeof result.content === 'string' && result.content.trim()) return result.content;
    if (typeof result.summary === 'string' && result.summary.trim()) return result.summary;
  }
  return '';
}
function readResultStatus(result: unknown) {
  if (!isRecord(result) || typeof result.status !== 'string') return '';
  return result.status;
}
function normalizeText(text: string) {
  return text.replace(/\r\n/g, '\n');
}
function splitLines(text: string) {
  return normalizeText(text).split('\n');
}
function lineLimit(text: string, maxLines: number) {
  const lines = splitLines(text);
  return {
    lines,
    visibleText: lines.slice(0, maxLines).join('\n'),
    isTruncated: lines.length > maxLines,
  };
}
function renderChevron(collapsed: boolean, fill: string) {
  return (
    <svg width="14" height="14" viewBox="0 0 256 256" fill={fill} aria-hidden="true">
      <path d={collapsed ? ICON_PATHS.CaretRight : ICON_PATHS.CaretDown} />
    </svg>
  );
}
function StatusDot({
  status,
  palette,
}: {
  status: ToolVisualStatus;
  palette: MobilePalette;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (status !== 'pending') return undefined;
    const timer = window.setInterval(() => {
      setExpanded((value) => !value);
    }, 760);
    return () => window.clearInterval(timer);
  }, [status]);
  const fill = status === 'success'
    ? palette.success
    : status === 'error'
      ? palette.danger
      : palette.accent;
  const ring = status === 'pending' && expanded
    ? `0 0 0 6px ${palette.accentSoft}`
    : 'none';
  return (
    <span
      aria-hidden="true"
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        backgroundColor: fill,
        boxShadow: ring,
        flexShrink: 0,
        opacity: status === 'pending' && !expanded ? 0.84 : 1,
        transform: status === 'pending' && expanded ? 'scale(1.05)' : 'scale(1)',
        transition: 'all 0.24s ease',
      }}
    />
  );
}
export function ToolCallCard({
  headerLabel,
  palette,
  light,
  status,
  defaultCollapsed = false,
  collapsedBody,
  footer,
  children,
}: ToolCallCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const headerColor = light ? '#6b7280' : palette.subduedText;
  const topBar = light ? 'rgba(255, 255, 255, 0.5)' : 'rgba(15, 23, 42, 0.34)';
  const body = collapsed ? (collapsedBody ?? null) : (children ?? null);
  return (
    <div
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid ${palette.cardBorder}`,
        background: palette.panelElevated,
        boxShadow: palette.shadow,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={(event) => {
          event.stopPropagation();
          setCollapsed((value) => !value);
        }}
        style={{
          width: '100%',
          minHeight: 44,
          border: 'none',
          borderBottom: body ? `1px solid ${palette.cardBorder}` : 'none',
          background: topBar,
          color: headerColor,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 12px',
          textAlign: 'left',
          fontFamily: MONO_FONT,
          fontSize: 12,
          lineHeight: 1.45,
          touchAction: 'manipulation',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 0,
            flex: 1,
          }}
        >
          <StatusDot status={status} palette={palette} />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {headerLabel}
          </span>
        </span>
        {renderChevron(collapsed, headerColor)}
      </button>
      {body ? (
        <div style={{ background: light ? 'rgba(255, 255, 255, 0.28)' : 'rgba(2, 6, 23, 0.16)' }}>
          {body}
        </div>
      ) : null}
      {footer ? (
        <div
          style={{
            borderTop: `1px solid ${palette.cardBorder}`,
            padding: '8px 12px 10px',
            fontSize: 12,
            color: palette.subduedText,
            fontFamily: mobileFontFamily(),
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
function CodeFrame({
  code,
  light,
  maxLines,
  diff = false,
  terminal = false,
}: {
  code: string;
  light: boolean;
  maxLines?: number;
  diff?: boolean;
  terminal?: boolean;
}) {
  const theme = codeTheme(light);
  const normalized = normalizeText(code);
  const lines = normalized.split('\n');
  const visibleLines = typeof maxLines === 'number' ? lines.slice(0, maxLines) : lines;
  const highlighted = highlightCode(visibleLines.join('\n'));
  const baseBackground = terminal
    ? (light ? '#eef2f7' : '#111827')
    : theme.bg;
  const baseText = terminal
    ? (light ? '#111827' : '#dbe4f0')
    : theme.text;
  return (
    <pre
      style={{
        margin: 0,
        overflowX: 'auto',
        backgroundColor: baseBackground,
        color: baseText,
        fontFamily: MONO_FONT,
        fontSize: 12.5,
        lineHeight: 1.7,
        padding: '12px 14px',
        whiteSpace: 'pre',
      }}
    >
      {highlighted.map((line, index) => {
        const rawLine = visibleLines[index] ?? '';
        const isAddition = diff && rawLine.startsWith('+') && !rawLine.startsWith('+++');
        const isDeletion = diff && rawLine.startsWith('-') && !rawLine.startsWith('---');
        const isHunk = diff && rawLine.startsWith('@@');
        const isMeta = diff && (rawLine.startsWith('---') || rawLine.startsWith('+++'));
        const backgroundColor = isAddition
          ? theme.diffAdd
          : isDeletion
            ? theme.diffDel
            : isHunk
              ? theme.diffHunk
              : undefined;
        const forcedColor = isAddition
          ? theme.diffAddColor
          : isDeletion
            ? theme.diffDelColor
            : isHunk || isMeta
              ? theme.diffHunkColor
              : undefined;

        return (
          <Fragment key={`code-line-${index}`}>
            <span
              style={backgroundColor ? {
                backgroundColor,
                display: 'inline-block',
                width: '100%',
                marginLeft: -14,
                marginRight: -14,
                paddingLeft: 14,
                paddingRight: 14,
              } : undefined}
            >
              {line.tokens.map((token, tokenIndex) => (
                <span
                  key={`token-${index}-${tokenIndex}`}
                  style={{
                    color: forcedColor ?? (terminal
                      ? baseText
                      : token.type === 'keyword'
                        ? theme.keyword
                        : token.type === 'string'
                          ? theme.string
                          : token.type === 'number'
                            ? theme.number
                            : token.type === 'comment'
                              ? theme.comment
                              : token.type === 'function'
                                ? theme.fn
                                : theme.text),
                  }}
                >
                  {token.value}
                </span>
              ))}
            </span>
            {index < visibleLines.length - 1 ? '\n' : null}
          </Fragment>
        );
      })}
    </pre>
  );
}
function buildUnifiedDiff(before: string, after: string, filePath: string) {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const diff = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push(` ${oldLines[oldIndex]}`);
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      diff.push(`-${oldLines[oldIndex]}`);
      oldIndex += 1;
      continue;
    }

    diff.push(`+${newLines[newIndex]}`);
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    diff.push(`-${oldLines[oldIndex]}`);
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diff.push(`+${newLines[newIndex]}`);
    newIndex += 1;
  }
  return diff.join('\n');
}
export function DiffCard({
  path,
  before,
  after,
  summary,
  palette,
  light,
  status,
}: {
  path: string;
  before: string;
  after: string;
  summary?: string;
  palette: MobilePalette;
  light: boolean;
  status: ToolVisualStatus;
}) {
  const diffText = buildUnifiedDiff(before, after, path);
  const preview = lineLimit(diffText, 14);
  return (
    <ToolCallCard
      headerLabel={path}
      palette={palette}
      light={light}
      status={status}
      defaultCollapsed={preview.isTruncated}
      collapsedBody={<CodeFrame code={preview.visibleText} light={light} diff />}
      footer={summary}
    >
      <CodeFrame code={diffText} light={light} diff />
    </ToolCallCard>
  );
}
export function ReadFileCard({
  path,
  content,
  palette,
  light,
  status,
}: {
  path: string;
  content: string;
  palette: MobilePalette;
  light: boolean;
  status: ToolVisualStatus;
}) {
  const preview = lineLimit(content || '// No file preview returned.', 20);
  return (
    <ToolCallCard
      headerLabel={path}
      palette={palette}
      light={light}
      status={status}
      defaultCollapsed={preview.isTruncated}
      collapsedBody={<CodeFrame code={preview.visibleText} light={light} maxLines={20} />}
      footer={preview.isTruncated ? `${preview.lines.length} lines` : undefined}
    >
      <CodeFrame code={content || '// No file preview returned.'} light={light} />
    </ToolCallCard>
  );
}
export function ShellCard({
  command,
  output,
  palette,
  light,
  status,
}: {
  command: string;
  output: string;
  palette: MobilePalette;
  light: boolean;
  status: ToolVisualStatus;
}) {
  const preview = lineLimit(output || '(command completed with no output)', 10);
  return (
    <ToolCallCard
      headerLabel={command}
      palette={palette}
      light={light}
      status={status}
      defaultCollapsed={preview.isTruncated}
      collapsedBody={<CodeFrame code={preview.visibleText} light={light} maxLines={10} terminal />}
    >
      <CodeFrame code={output || '(command completed with no output)'} light={light} terminal />
    </ToolCallCard>
  );
}
function GenericToolCard({
  toolName,
  headerLabel,
  body,
  palette,
  light,
  status,
}: {
  toolName: string;
  headerLabel: string;
  body: string;
  palette: MobilePalette;
  light: boolean;
  status: ToolVisualStatus;
}) {
  const preview = lineLimit(body, 12);
  const metaStyle: CSSProperties = {
    padding: '10px 12px 0',
    fontSize: 11,
    color: palette.subduedText,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontWeight: 700,
  };
  return (
    <ToolCallCard
      headerLabel={headerLabel}
      palette={palette}
      light={light}
      status={status}
      defaultCollapsed={preview.isTruncated}
      collapsedBody={
        <div>
          <div style={metaStyle}>{toolName}</div>
          <CodeFrame code={preview.visibleText} light={light} maxLines={12} />
        </div>
      }
    >
      <div>
        <div style={metaStyle}>{toolName}</div>
        <CodeFrame code={body} light={light} />
      </div>
    </ToolCallCard>
  );
}
function getToolVisualStatus({
  pending,
  isError,
  result,
}: {
  pending?: boolean;
  isError?: boolean;
  result?: unknown;
}): ToolVisualStatus {
  if (pending) return 'pending';
  if (isError || readResultStatus(result) === 'blocked' || readResultStatus(result) === 'error') {
    return 'error';
  }
  return 'success';
}
export function renderToolPart(toolName: string, input: ToolRenderInput) {
  const args = input.args;
  const preview = readPreview(input.result);
  const status = getToolVisualStatus(input);
  if (toolName === 'edit_file') {
    const path = readStringArg(args, 'path', 'file_path') || 'Edited file';
    const before = typeof args?.oldText === 'string' ? args.oldText : '';
    const after = typeof args?.newText === 'string' ? args.newText : '';
    if (before || after) {
      return (
        <DiffCard
          path={path}
          before={before}
          after={after}
          summary={preview || undefined}
          palette={input.palette}
          light={input.light}
          status={status}
        />
      );
    }
  }
  if (toolName === 'read_file' || toolName === 'write_file') {
    const path = readStringArg(args, 'path', 'file_path') || 'File preview';
    const content = preview || (toolName === 'write_file' && typeof args?.content === 'string' ? args.content : '');
    return (
      <ReadFileCard
        path={path}
        content={content}
        palette={input.palette}
        light={input.light}
        status={status}
      />
    );
  }
  if (toolName === 'run_terminal_command' || toolName === 'exec_command') {
    const command = readStringArg(args, 'command', 'cmd') || toolName;
    return (
      <ShellCard
        command={command}
        output={preview}
        palette={input.palette}
        light={input.light}
        status={status}
      />
    );
  }
  const headerLabel = readStringArg(args, 'path', 'file_path', 'command', 'cmd', 'query') || toolName;
  const body = preview
    || input.argsText
    || stringifyValue(args)
    || stringifyValue(input.result)
    || `${toolName} finished without a preview.`;
  return (
    <GenericToolCard
      toolName={toolName}
      headerLabel={headerLabel}
      body={body}
      palette={input.palette}
      light={input.light}
      status={status}
    />
  );
}
