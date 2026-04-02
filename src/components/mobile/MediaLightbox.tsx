import { Download, ExternalLink, FileText, X } from 'lucide-react';
import type { MediaLightboxProps } from './types';
import { useTheme } from './ThemeContext';
import { isImageMedia, mediaHref } from './utils';

export function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  const { colors } = useTheme();

  if (!media) {
    return null;
  }

  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    zIndex: 70,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    background: 'rgba(0,0,0,0.78)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  } as const;
  const surfaceStyle = {
    width: 'min(100%, 420px)',
    display: 'grid',
    gap: 14,
    padding: 16,
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.82)',
    boxShadow: '0 20px 44px rgba(0,0,0,0.34)',
  } as const;
  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    color: colors.text,
  } as const;
  const iconButtonStyle = {
    width: 36,
    height: 36,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.text,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  } as const;
  const bodyStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    overflow: 'hidden',
  } as const;
  const fileStyle = {
    display: 'grid',
    justifyItems: 'center',
    gap: 10,
    padding: 24,
    color: colors.textSecondary,
    textAlign: 'center',
  } as const;
  const actionsStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10,
  } as const;
  const actionLinkStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    padding: '0 14px',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(44,44,46,0.9)',
    color: colors.text,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: 'none',
  } as const;
  const primaryActionLinkStyle = {
    ...actionLinkStyle,
    borderColor: 'rgba(10,132,255,0.24)',
    background: 'rgba(10,132,255,0.18)',
    color: colors.blueAccent,
  } as const;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" onClick={onClose}>
      <section style={surfaceStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <strong>{media.name}</strong>
          <button type="button" style={iconButtonStyle} onClick={onClose} aria-label="Close media viewer">
            <X size={16} strokeWidth={2.1} />
          </button>
        </div>
        <div style={bodyStyle}>
          {isImageMedia(media) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaHref(media.path)}
              alt={media.name}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          ) : (
            <div style={fileStyle}>
              <FileText size={32} strokeWidth={2.1} />
              <p style={{ margin: 0 }}>{media.name}</p>
            </div>
          )}
        </div>
        <div style={actionsStyle}>
          <a href={mediaHref(media.path)} target="_blank" rel="noreferrer" style={actionLinkStyle}>
            <ExternalLink size={16} strokeWidth={2.1} />
            Open
          </a>
          <a href={mediaHref(media.path, true)} download={media.name} style={primaryActionLinkStyle}>
            <Download size={16} strokeWidth={2.1} />
            Save
          </a>
        </div>
      </section>
    </div>
  );
}
