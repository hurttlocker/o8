import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { useTheme } from './ThemeContext';
import { diffLineTone } from './utils';

type MobileChromeButtonProps = {
  children: ReactNode;
  label: string;
  tone?: 'light' | 'dark';
} & ButtonHTMLAttributes<HTMLButtonElement>;

type ReferencePalette = {
  primary: string;
  secondary: string;
  tertiary: string;
  surfaceBg: string;
  surfaceBorder: string;
  raisedBg: string;
  raisedBorder: string;
  selectedBg: string;
  selectedBorder: string;
  accent: string;
  accentMuted: string;
  shadow: string;
  fabBg: string;
  previewBg: string;
  codeBg: string;
  addBg: string;
  addText: string;
  removeBg: string;
  removeText: string;
  metaBg: string;
  metaText: string;
  contextText: string;
};

function useReferencePalette(): ReferencePalette {
  const { colors, isDark } = useTheme();

  if (isDark) {
    return {
      primary: '#F5F5F7',
      secondary: '#8E8E93',
      tertiary: '#636366',
      surfaceBg: 'rgba(28,28,30,0.82)',
      surfaceBorder: 'rgba(255,255,255,0.08)',
      raisedBg: 'rgba(44,44,46,0.92)',
      raisedBorder: 'rgba(255,255,255,0.12)',
      selectedBg: 'rgba(10,132,255,0.14)',
      selectedBorder: 'rgba(10,132,255,0.28)',
      accent: colors.blueAccent,
      accentMuted: 'rgba(10,132,255,0.82)',
      shadow: '0 14px 28px rgba(0,0,0,0.24)',
      fabBg: colors.blueAccent,
      previewBg: 'rgba(18,18,20,0.96)',
      codeBg: 'rgba(255,255,255,0.05)',
      addBg: 'rgba(48,209,88,0.14)',
      addText: colors.green,
      removeBg: 'rgba(255,69,58,0.14)',
      removeText: colors.red,
      metaBg: 'rgba(99,99,102,0.22)',
      metaText: '#8E8E93',
      contextText: '#D1D1D6',
    };
  }

  return {
    primary: colors.text,
    secondary: colors.textSecondary,
    tertiary: colors.textTertiary,
    surfaceBg: colors.panelBg,
    surfaceBorder: 'rgba(0,0,0,0.06)',
    raisedBg: colors.frostStrong,
    raisedBorder: 'rgba(0,0,0,0.08)',
    selectedBg: colors.blueGlass,
    selectedBorder: colors.blueGlassBorder,
    accent: colors.blueAccent,
    accentMuted: colors.blueAccent,
    shadow: colors.shadow,
    fabBg: colors.blueAccent,
    previewBg: 'rgba(255,255,255,0.94)',
    codeBg: 'rgba(0,0,0,0.04)',
    addBg: 'rgba(52,199,89,0.12)',
    addText: colors.green,
    removeBg: 'rgba(255,59,48,0.12)',
    removeText: colors.red,
    metaBg: 'rgba(0,0,0,0.04)',
    metaText: colors.textSecondary,
    contextText: colors.text,
  };
}

function ChevronRightIcon({
  size = 16,
  style,
}: {
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      style={style}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function MobileChromeButton({
  children,
  label,
  tone = 'light',
  className: _className,
  style,
  type = 'button',
  ...props
}: MobileChromeButtonProps) {
  const palette = useReferencePalette();
  const buttonStyle: CSSProperties = {
    minWidth: 44,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    background: tone === 'dark' ? palette.raisedBg : palette.surfaceBg,
    border: `1px solid ${tone === 'dark' ? palette.raisedBorder : palette.surfaceBorder}`,
    color: palette.primary,
    boxShadow: palette.shadow,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    WebkitTapHighlightColor: 'transparent',
    transition: 'transform 180ms ease, background 180ms ease, border-color 180ms ease',
    flexShrink: 0,
  };

  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      style={{ ...buttonStyle, ...style }}
    >
      {children}
    </button>
  );
}

export function MobileSectionLabel({ children }: { children: ReactNode }) {
  const palette = useReferencePalette();
  const labelStyle: CSSProperties = {
    margin: 0,
    color: palette.secondary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '0.94rem',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  };

  return <p style={labelStyle}>{children}</p>;
}

interface MobileListRowProps {
  title: string;
  subtitle: string;
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

export function MobileListRow({
  title,
  subtitle,
  leadingIcon,
  trailing,
  selected = false,
  onClick,
}: MobileListRowProps) {
  const palette = useReferencePalette();

  const rowStyle: CSSProperties = {
    width: '100%',
    minHeight: 56,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    border: `1px solid ${selected ? palette.selectedBorder : palette.surfaceBorder}`,
    borderRadius: 14,
    background: selected ? palette.selectedBg : palette.surfaceBg,
    color: palette.primary,
    textAlign: 'left',
    boxShadow: palette.shadow,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 180ms ease, border-color 180ms ease, transform 180ms ease',
    cursor: onClick ? 'pointer' : 'default',
  };

  const copyStyle: CSSProperties = {
    minWidth: 0,
    flex: 1,
    display: 'grid',
    gap: 4,
  };

  const titleStyle: CSSProperties = {
    color: palette.primary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '1.02rem',
    fontWeight: selected ? 700 : 500,
    letterSpacing: '-0.025em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const subtitleStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: palette.secondary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '0.78rem',
    fontWeight: 500,
    minWidth: 0,
  };

  const iconStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: selected ? palette.accentMuted : palette.tertiary,
    flexShrink: 0,
  };

  const trailingStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: selected ? palette.accent : palette.tertiary,
    flexShrink: 0,
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={rowStyle}
    >
      <div style={copyStyle}>
        <span style={titleStyle}>{title}</span>
        <span style={subtitleStyle}>
          {leadingIcon ? <span style={iconStyle}>{leadingIcon}</span> : null}
          <span>{subtitle}</span>
        </span>
      </div>
      <span style={trailingStyle}>
        {trailing ?? <ChevronRightIcon size={16} />}
      </span>
    </button>
  );
}

export function MobileFloatingActionButton({
  children,
  label,
  className: _className,
  style,
  type = 'button',
  ...props
}: MobileChromeButtonProps) {
  const palette = useReferencePalette();
  const buttonStyle: CSSProperties = {
    minWidth: 58,
    minHeight: 58,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    border: `1px solid ${palette.surfaceBorder}`,
    background: palette.fabBg,
    color: '#FFFFFF',
    fontSize: '2rem',
    lineHeight: 1,
    boxShadow: palette.shadow,
    WebkitTapHighlightColor: 'transparent',
    pointerEvents: 'auto',
  };

  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      style={{ ...buttonStyle, ...style }}
    >
      {children}
    </button>
  );
}

interface MobileActivitySummaryRowProps {
  summary: string;
  onClick?: () => void;
  expanded?: boolean;
}

export function MobileActivitySummaryRow({
  summary,
  onClick,
  expanded = false,
}: MobileActivitySummaryRowProps) {
  const palette = useReferencePalette();
  const rowStyle: CSSProperties = {
    width: 'fit-content',
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 12px',
    border: `1px solid ${palette.surfaceBorder}`,
    borderRadius: 999,
    background: palette.surfaceBg,
    color: palette.secondary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '0.82rem',
    fontWeight: 500,
    boxShadow: palette.shadow,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    WebkitTapHighlightColor: 'transparent',
    cursor: onClick ? 'pointer' : 'default',
  };

  const chevronStyle: CSSProperties = {
    color: palette.tertiary,
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
    transition: 'transform 180ms ease',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      style={rowStyle}
    >
      <span>{summary}</span>
      <ChevronRightIcon size={13} style={chevronStyle} />
    </button>
  );
}

interface MobileArtifactCardProps {
  action: string;
  path: string;
  preview: string;
}

function artifactLineStyles(tone: ReturnType<typeof diffLineTone>, palette: ReferencePalette) {
  const baseStyle: CSSProperties = {
    padding: '4px 14px',
  };

  switch (tone) {
    case 'add':
      return {
        row: { ...baseStyle, background: palette.addBg },
        code: { color: palette.addText },
      };
    case 'remove':
      return {
        row: { ...baseStyle, background: palette.removeBg },
        code: { color: palette.removeText },
      };
    case 'meta':
    case 'hunk':
      return {
        row: { ...baseStyle, background: palette.metaBg },
        code: { color: palette.metaText },
      };
    case 'context':
    default:
      return {
        row: baseStyle,
        code: { color: palette.contextText },
      };
  }
}

export function MobileArtifactCard({
  action,
  path,
  preview,
}: MobileArtifactCardProps) {
  const palette = useReferencePalette();
  const previewLines = preview.split('\n').filter(Boolean).slice(0, 10);

  if (!previewLines.length) {
    return null;
  }

  const cardStyle: CSSProperties = {
    overflow: 'hidden',
    borderRadius: 14,
    border: `1px solid ${palette.surfaceBorder}`,
    background: palette.surfaceBg,
    boxShadow: palette.shadow,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };

  const headerStyle: CSSProperties = {
    display: 'grid',
    gap: 4,
    padding: '12px 14px 10px',
    borderBottom: `1px solid ${palette.surfaceBorder}`,
  };

  const actionStyle: CSSProperties = {
    color: palette.secondary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  };

  const pathStyle: CSSProperties = {
    color: palette.primary,
    fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
    fontSize: '0.77rem',
    lineHeight: 1.45,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    padding: '6px 8px',
    borderRadius: 10,
    background: palette.codeBg,
  };

  const previewStyle: CSSProperties = {
    display: 'grid',
    background: palette.previewBg,
  };

  const codeStyle: CSSProperties = {
    display: 'block',
    fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
    fontSize: '0.76rem',
    lineHeight: 1.52,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  return (
    <div style={cardStyle}>
      <header style={headerStyle}>
        <span style={actionStyle}>{action}</span>
        <code style={pathStyle}>{path}</code>
      </header>
      <div style={previewStyle}>
        {previewLines.map((line, index) => {
          const tone = diffLineTone(line);
          const lineStyles = artifactLineStyles(tone, palette);

          return (
            <div
              key={`${path}-${index}`}
              style={lineStyles.row}
            >
              <code style={{ ...codeStyle, ...lineStyles.code }}>{line}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
