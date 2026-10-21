'use client';

import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEventHandler, type ReactNode, type RefObject } from 'react';
import { useTheme } from '@/lib/theme/context';
import { getPalette } from '@/lib/theme/registry';
import { isTauri } from '@/lib/tauri/bridge';

/** Full-window setup shares native material, with no workspace content behind it. */
export function OnboardingSurface({ children, rootRef, onKeyDown, sound, loading = false }: {
  children: ReactNode;
  rootRef?: RefObject<HTMLDivElement | null>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  sound?: 'silent';
  loading?: boolean;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = rootRef ?? ownRef;
  const { surface } = useTheme();
  const nativeGlass = isTauri() && surface === 'glass';

  useLayoutEffect(() => {
    if (!ref.current) return;
    const prior = new Map<HTMLElement, { visibility: string; visibilityPriority: string; opacity: string; opacityPriority: string;
      inert: boolean; zIndex: string; zIndexPriority: string; portal: boolean }>();
    const branches = new Map<HTMLElement, HTMLElement>();
    let branch: HTMLElement = ref.current;
    while (branch.parentElement) {
      branches.set(branch.parentElement, branch);
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    const obscure = () => {
      for (const [parent, active] of branches) for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || sibling === active || prior.has(sibling)
          || sibling.matches('script, style, link, meta, [data-onboarding-preview-controls], [role="dialog"], [role="alertdialog"]')) continue;
        const portal = sibling.matches('[data-o8-settings-portal]') && Boolean(sibling.id)
          && Array.from(ref.current?.querySelectorAll('[aria-controls]') ?? [])
            .some((control) => control.getAttribute('aria-controls')?.split(/\s+/).includes(sibling.id));
        if (!portal && !nativeGlass) continue;
        prior.set(sibling, { visibility: sibling.style.visibility, visibilityPriority: sibling.style.getPropertyPriority('visibility'),
          opacity: sibling.style.opacity, opacityPriority: sibling.style.getPropertyPriority('opacity'), inert: sibling.inert,
          zIndex: sibling.style.zIndex, zIndexPriority: sibling.style.getPropertyPriority('z-index'), portal });
        if (portal) sibling.style.setProperty('z-index', '100000', 'important');
        else {
          sibling.style.setProperty('visibility', 'hidden', 'important');
          sibling.style.setProperty('opacity', '0', 'important');
          sibling.inert = true;
        }
      }
    };
    obscure();
    const observer = new MutationObserver(obscure);
    for (const parent of branches.keys()) observer.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      for (const [sibling, saved] of prior) {
        if (saved.portal) {
          if (sibling.style.zIndex === '100000' && sibling.style.getPropertyPriority('z-index') === 'important') {
            sibling.style.setProperty('z-index', saved.zIndex, saved.zIndexPriority);
          }
          continue;
        }
        if (sibling.style.visibility === 'hidden' && sibling.style.getPropertyPriority('visibility') === 'important') {
          sibling.style.setProperty('visibility', saved.visibility, saved.visibilityPriority);
        }
        if (sibling.style.opacity === '0' && sibling.style.getPropertyPriority('opacity') === 'important') {
          sibling.style.setProperty('opacity', saved.opacity, saved.opacityPriority);
        }
        if (sibling.inert) sibling.inert = saved.inert;
      }
    };
  }, [nativeGlass, ref]);

  const dark = getPalette('dark');
  const glassStyle = nativeGlass ? {
    '--t-onboarding-surface-bg': 'var(--t-bg)',
    // Primary actions fill with native white ink; their own ink stays opaque.
    '--t-onboarding-bg': dark.baseTokens['--t-onboarding-bg'],
    '--t-onboarding-control-bg': 'var(--t-btn-secondary-bg)',
    // A scrolling action dock stacks above text, so it keeps the shared frost.
    '--t-onboarding-dock-bg': dark.glassTokens['--t-panel-solid'],
  } : {};
  return <div ref={ref} data-o8-onboarding="" data-chrome-surface={nativeGlass ? true : undefined}
    data-onboarding-sound={sound} role={loading ? 'status' : 'dialog'} aria-modal={loading ? undefined : true}
    aria-label={loading ? undefined : 'Set up o8'} onKeyDown={onKeyDown} style={{
      ...glassStyle, position: 'fixed', inset: 0, zIndex: 99998, display: loading ? 'grid' : 'flex',
      placeItems: loading ? 'center' : undefined, flexDirection: 'column',
      background: 'var(--t-onboarding-surface-bg, var(--t-onboarding-bg))',
      color: loading ? 'var(--t-text-secondary)' : 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
    } as CSSProperties}>{children}</div>;
}
