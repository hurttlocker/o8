'use client';

/**
 * PortalCard — the o8 brand motif as a card surface.
 *
 * NOT a landscape used as a full-bleed background. Instead a clean glass card
 * (light "open the intelligent workspace" / dark "workspace, opened") with the
 * animated landscape set INSIDE a framed portal/window — light spilling out
 * onto the card. The card is glass + type; the scene is a glowing aperture.
 *
 * Reuses the existing animated scenes (FooterScene = bright day, SunriseFooter
 * = warm dawn) as the portal interior. Dependency-free.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { FooterScene, O8_DAY } from '../footer-scene/FooterScene';
import { SunriseFooter } from '../footer-sunrise/SunriseFooter';

type Variant = 'light' | 'dark';

export interface PortalCardProps {
  variant?: Variant;
  width?: number;
  height?: number;
  /** Portal (window) height in px. */
  portalHeight?: number;
  /** Soft arch on the portal top (px radius). */
  arch?: number;
  autoPlay?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const THEME: Record<Variant, {
  bg: string; border: string; shadow: string; ink: string; sub: string;
  glow: string; frame: string; threshold: string;
}> = {
  light: {
    bg: 'linear-gradient(180deg, #fcfdfe 0%, #eef2f6 100%)',
    border: 'rgba(20,32,46,0.10)',
    shadow: '0 30px 70px -34px rgba(28,44,70,0.34), 0 2px 6px -2px rgba(28,44,70,0.10)',
    ink: '#1b2430',
    sub: '#5d6a78',
    glow: 'rgba(150,198,255,0.55)',
    frame: 'rgba(255,255,255,0.75)',
    threshold: 'rgba(255,255,255,0.7)',
  },
  dark: {
    bg: 'linear-gradient(180deg, #1a1f27 0%, #0e1117 100%)',
    border: 'rgba(255,255,255,0.09)',
    shadow: '0 34px 80px -34px rgba(0,0,0,0.75), 0 2px 6px -2px rgba(0,0,0,0.5)',
    ink: '#eaeff4',
    sub: '#9aa6b3',
    glow: 'rgba(255,176,96,0.45)',
    frame: 'rgba(255,255,255,0.14)',
    threshold: 'rgba(255,224,180,0.5)',
  },
};

export function PortalCard(props: PortalCardProps) {
  const variant = props.variant ?? 'light';
  const width = props.width ?? 380;
  const height = props.height ?? 480;
  const portalHeight = props.portalHeight ?? 208;
  const arch = props.arch ?? 18;
  const autoPlay = props.autoPlay ?? true;
  const t = THEME[variant];

  return (
    <div
      className={props.className}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 24,
        paddingTop: 16,
        paddingLeft: 16,
        paddingRight: 16,
        paddingBottom: 18,
        background: t.bg,
        border: `1px solid ${t.border}`,
        boxShadow: t.shadow,
        overflow: 'hidden',
        ...props.style,
      }}
    >
      {/* light bloom from the portal onto the card body */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: -30,
          height: portalHeight + 110,
          pointerEvents: 'none',
          background: `radial-gradient(120% 60% at 70% 36%, ${t.glow}, transparent 62%)`,
          opacity: 0.9,
        }}
      />

      {/* the portal / window */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: portalHeight,
          borderTopLeftRadius: arch,
          borderTopRightRadius: arch,
          borderBottomLeftRadius: 14,
          borderBottomRightRadius: 14,
          overflow: 'hidden',
          boxShadow: `0 0 0 1px ${t.frame}, 0 14px 34px -10px ${t.glow}`,
        }}
      >
        {variant === 'light' ? (
          <FooterScene
            palette={O8_DAY}
            height={portalHeight}
            horizon={0.3}
            sunX={0.72}
            sunY={0.52}
            mistDensity={0.5}
            cloudScale={0.85}
            birdRate={6}
            maxBirds={1}
            autoPlay={autoPlay}
          />
        ) : (
          <SunriseFooter
            height={portalHeight}
            horizon={0.5}
            sunX={0.7}
            sunY={0.56}
            fog={1}
            grassHeight={0.12}
            scale={0.9}
            birdRate={6}
            maxBirds={1}
            autoPlay={autoPlay}
          />
        )}
        {/* glass threshold — a bright top edge + subtle inner vignette, the
            "light pouring through the opening" read */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: `inset 0 1px 0 ${t.threshold}, inset 0 -22px 30px -18px rgba(0,0,0,0.18)`,
          }}
        />
      </div>

      {/* content */}
      <div style={{ position: 'relative', marginTop: 16, color: t.ink }}>{props.children}</div>
    </div>
  );
}

export default PortalCard;
