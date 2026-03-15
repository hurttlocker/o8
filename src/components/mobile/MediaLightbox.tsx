import Image from 'next/image';
import { Download, ExternalLink, FileText, X } from 'lucide-react';
import type { MediaLightboxProps } from './types';
import { isImageMedia, mediaHref } from './utils';

export function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  if (!media) {
    return null;
  }

  return (
    <div className="remodex-media-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="remodex-media-lightbox" onClick={(event) => event.stopPropagation()}>
        <div className="remodex-media-lightbox-head">
          <strong>{media.name}</strong>
          <button type="button" className="remodex-sheet-icon-button" onClick={onClose} aria-label="Close media viewer">
            <X size={16} strokeWidth={2.1} />
          </button>
        </div>
        <div className="remodex-media-lightbox-body">
          {isImageMedia(media) ? (
            <Image
              src={mediaHref(media.path)}
              alt={media.name}
              width={1600}
              height={1200}
              unoptimized
              className="remodex-media-lightbox-image"
            />
          ) : (
            <div className="remodex-media-lightbox-file">
              <FileText size={32} strokeWidth={2.1} />
              <p>{media.name}</p>
            </div>
          )}
        </div>
        <div className="remodex-media-lightbox-actions">
          <a href={mediaHref(media.path)} target="_blank" rel="noreferrer" className="remodex-media-action-link">
            <ExternalLink size={16} strokeWidth={2.1} />
            Open
          </a>
          <a href={mediaHref(media.path, true)} download={media.name} className="remodex-media-action-link remodex-media-action-link-primary">
            <Download size={16} strokeWidth={2.1} />
            Save
          </a>
        </div>
      </section>
    </div>
  );
}
