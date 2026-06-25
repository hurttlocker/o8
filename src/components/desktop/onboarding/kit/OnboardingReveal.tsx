'use client';

/**
 * Onboarding kit — the shared "reveal": an Aurora ASCII wordmark pane. Used by
 * the app open (OnboardingOpen) and the canvas welcome so both onboardings speak
 * ONE visual language. Pass resolved colors; the caller decides how it resolves
 * them (app `--t-*` theme vs canvas tone). Swap `text` for other cards later —
 * this is the one place the reveal config lives.
 */

import { useEffect, useState } from 'react';
import { AsciiImage } from '@/app/preview/effects/AsciiImage';

export function OnboardingReveal({ bg, glyph, text = 'o8' }: { bg: string; glyph: string; text?: string }) {
  return (
    <AsciiImage
      text={text}
      color={glyph}
      backgroundColor={bg}
      cellSize={11}
      speed={1}
      baseLevel={0.42}
      waveBoost={0.95}
      contrast={1.25}
      cursorRipple={26}
      cursorRadius={0.22}
      width="100%"
      height="100%"
    />
  );
}

/**
 * Resolve the ASCII stage colors from the live APP theme, re-reading on toggle.
 * For surfaces that follow the app palette (OnboardingOpen). Canvas surfaces pass
 * their own tone-derived colors instead (they have a separate tone system).
 */
export function useStageColors(): { bg: string; glyph: string } {
  const [colors, setColors] = useState<{ bg: string; glyph: string }>({ bg: '#08080b', glyph: '#ff7a18' });
  useEffect(() => {
    const lum = (c: string): number => {
      try {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.appendChild(el);
        const rgb = getComputedStyle(el).color;
        document.body.removeChild(el);
        const m = rgb.match(/(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
        if (!m) return 0;
        return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
      } catch {
        return 0;
      }
    };
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const surface = cs.getPropertyValue('--t-chat-surface-bg').trim() || '#08080b';
      const dark = lum(surface) < 0.5;
      // Amber pops on dark; a deeper ember reads crisply on a paper surface.
      setColors({ bg: surface, glyph: dark ? '#ff7a18' : '#d65a12' });
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-palette', 'data-surface'] });
    return () => obs.disconnect();
  }, []);
  return colors;
}
