'use client';

import { useId, useRef, useState, type CSSProperties } from 'react';
import { CANVAS_BACKDROPS, writeCanvasGlassSettings, type CanvasGlassSettings } from '@/lib/canvas-mode/glass-settings';
import { prepareCanvasImage, type CanvasImageMode } from '@/lib/canvas-mode/custom-background';

const button: CSSProperties = {
  height: 26, border: 0, borderRadius: 7, paddingTop: 0, paddingBottom: 0, paddingLeft: 6, paddingRight: 6,
  fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px',
  color: 'var(--cnv-ink)', background: 'transparent', cursor: 'pointer',
};

export function CanvasBackdropPicker({ settings, onChange }: {
  settings: CanvasGlassSettings;
  onChange: (patch: Partial<CanvasGlassSettings>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const confirmId = useId();
  const customTrigger = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const image = settings.customBackground;
  const select = (patch: Partial<CanvasGlassSettings>) => {
    // Persist before applying: quota failure must leave the saved and visible image intact.
    writeCanvasGlassSettings({ ...settings, ...patch }, { requirePersistence: true });
    onChange(patch);
    setError('');
  };
  const save = (patch: Partial<CanvasGlassSettings>) => {
    try { select(patch); setStatus('Saved on this device.'); return true; }
    catch { setError('The background could not be saved. Free some device storage and try again.'); return false; }
  };
  const choose = async (file: File) => {
    setBusy(true); setError(''); setStatus('Reading image…');
    try {
      const dataUrl = await prepareCanvasImage(file);
      select({ backdrop: 'custom', customBackground: {
        dataUrl, name: file.name, mode: image?.mode ?? 'photo',
        previousBackdrop: settings.backdrop === 'custom' ? image?.previousBackdrop ?? 'none' : settings.backdrop,
      } });
      setStatus('Saved on this device.');
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error && !['QuotaExceededError', 'SecurityError'].includes(cause.name)
        ? cause.message : 'The background could not be saved. Free some device storage and try again.');
    } finally { setBusy(false); }
  };

  return (
    <section aria-label="Canvas background" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>Background</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
        {CANVAS_BACKDROPS.map(backdrop => <button key={backdrop.id} type="button" disabled={busy}
          ref={backdrop.id === 'custom' ? customTrigger : undefined}
          aria-pressed={settings.backdrop === backdrop.id}
          onClick={() => {
            if (backdrop.id !== 'custom') return save({ backdrop: backdrop.id });
            if (!image) return input.current?.click();
            save({ backdrop: 'custom', customBackground: {
              ...image, previousBackdrop: settings.backdrop === 'custom' ? image.previousBackdrop : settings.backdrop,
            } });
          }}
          style={{ ...button, background: settings.backdrop === backdrop.id ? 'var(--cnv-tint-deep)' : 'transparent', gridColumn: backdrop.id === 'custom' ? 'span 2' : undefined }}>
          {backdrop.label}
        </button>)}
      </div>
      <input ref={input} aria-label="Choose custom canvas image" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy}
        style={{ display: 'none' }} onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) void choose(file);
        }} />
      {image ? <>
        <span style={{ fontSize: 10, overflowWrap: 'anywhere', color: 'var(--cnv-ink-muted)' }}>{image.name}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['photo', 'ascii', 'dither'] as CanvasImageMode[]).map(mode => <button type="button" key={mode} disabled={busy}
            aria-pressed={image.mode === mode} onClick={() => save({ customBackground: { ...image, mode } })}
            style={{ ...button, flex: 1, background: image.mode === mode ? 'var(--cnv-tint-deep)' : 'transparent' }}>
            {mode === 'photo' ? 'Photo' : mode === 'ascii' ? 'ASCII' : 'Dither'}
          </button>)}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" disabled={busy} style={button} onClick={() => input.current?.click()}>Replace image</button>
          <button type="button" ref={removeTrigger} disabled={busy} style={{ ...button, color: 'var(--t-danger, var(--cnv-ink))' }}
            aria-expanded={confirmRemove} aria-controls={confirmId} onClick={() => setConfirmRemove(true)}>Remove image</button>
        </div>
        {confirmRemove ? <div id={confirmId} role="group" aria-label="Remove saved background image" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--cnv-ink-muted)' }}>Remove the saved background? The original file stays on this device.</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" disabled={busy} style={{ ...button, color: 'var(--t-danger, var(--cnv-ink))' }} onClick={() => {
              if (save({ customBackground: undefined, backdrop: settings.backdrop === 'custom' ? image.previousBackdrop : settings.backdrop })) {
                setConfirmRemove(false);
                customTrigger.current?.focus();
              }
            }}>Remove background image</button>
            <button type="button" style={button} onClick={() => { setConfirmRemove(false); removeTrigger.current?.focus(); }}>Cancel</button>
          </div>
        </div> : null}
      </> : null}
      <span style={{ fontSize: 10, color: 'var(--cnv-ink-muted)', lineHeight: 1.4 }}>PNG, JPEG or WebP, up to 5 MB. Stays on this device.</span>
      {status && !error ? <span role="status" style={{ fontSize: 10, color: 'var(--cnv-ink-muted)' }}>{status}</span> : null}
      {error ? <span role="alert" style={{ fontSize: 10, color: 'var(--t-danger, var(--cnv-ink))' }}>{error}</span> : null}
    </section>
  );
}
