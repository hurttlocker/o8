import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { diffLineTone } from './utils';

type MobileChromeButtonProps = {
  children: ReactNode;
  label: string;
  tone?: 'light' | 'dark';
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function MobileChromeButton({
  children,
  label,
  tone = 'light',
  className = '',
  type = 'button',
  ...props
}: MobileChromeButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={`remodex-reference-circle-button remodex-reference-circle-button-${tone}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function MobileSectionLabel({ children }: { children: ReactNode }) {
  return <p className="remodex-reference-section-label">{children}</p>;
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
  return (
    <button
      type="button"
      className={`remodex-reference-list-row${selected ? ' remodex-reference-list-row-selected' : ''}`}
      onClick={onClick}
    >
      <div className="remodex-reference-list-row-copy">
        <span className="remodex-reference-list-row-title">{title}</span>
        <span className="remodex-reference-list-row-subtitle">
          {leadingIcon ? <span className="remodex-reference-list-row-icon">{leadingIcon}</span> : null}
          <span>{subtitle}</span>
        </span>
      </div>
      <span className="remodex-reference-list-row-trailing">
        {trailing ?? <ChevronRight size={16} strokeWidth={1.9} />}
      </span>
    </button>
  );
}

export function MobileFloatingActionButton({
  children,
  label,
  ...props
}: MobileChromeButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className="remodex-reference-fab"
      {...props}
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
  return (
    <button
      type="button"
      className="remodex-reference-activity-row"
      onClick={onClick}
      aria-expanded={expanded}
    >
      <span>{summary}</span>
      <ChevronRight
        size={13}
        strokeWidth={1.9}
        className={`remodex-reference-activity-row-chevron${expanded ? ' remodex-reference-activity-row-chevron-open' : ''}`}
      />
    </button>
  );
}

interface MobileArtifactCardProps {
  action: string;
  path: string;
  preview: string;
}

export function MobileArtifactCard({
  action,
  path,
  preview,
}: MobileArtifactCardProps) {
  const previewLines = preview.split('\n').filter(Boolean).slice(0, 10);

  if (!previewLines.length) {
    return null;
  }

  return (
    <div className="remodex-reference-artifact-card">
      <header className="remodex-reference-artifact-card-head">
        <span className="remodex-reference-artifact-action">{action}</span>
        <code className="remodex-reference-artifact-path">{path}</code>
      </header>
      <div className="remodex-reference-artifact-preview">
        {previewLines.map((line, index) => {
          const tone = diffLineTone(line);
          return (
            <div
              key={`${path}-${index}`}
              className={`remodex-reference-artifact-line remodex-reference-artifact-line-${tone}`}
            >
              <code>{line}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
