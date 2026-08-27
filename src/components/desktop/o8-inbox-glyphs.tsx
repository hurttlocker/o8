const glyphProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'var(--o8-inbox-action-icon, #64748b)',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  style: { display: 'block', flexShrink: 0 },
};

export function FileTextGlyph() {
  return <svg {...glyphProps}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M8.5 13h7" /><path d="M8.5 16h5" /></svg>;
}

export function FolderGlyph() {
  return <svg {...glyphProps}><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z" /><path d="M4 10h16" /></svg>;
}

export function ChatGlyph() {
  return <svg {...glyphProps}><path d="M5 5.5h14a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H11l-4.4 3v-3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" /><path d="M8 10h8" /><path d="M8 13.5h5.5" /></svg>;
}

export function RetryGlyph() {
  return <svg {...glyphProps}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>;
}

export function StopGlyph() {
  return <svg {...glyphProps}><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>;
}

export function ArchiveGlyph() {
  return <svg {...glyphProps}><path d="M4 5.5h16v4H4z" /><path d="M6 9.5V19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9.5" /><path d="M9.5 14h5" /></svg>;
}

export function ExternalLinkGlyph() {
  return <svg {...glyphProps}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>;
}
