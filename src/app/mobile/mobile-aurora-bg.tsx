'use client';

import type { CSSProperties } from 'react';

export function MobileAuroraBg({ themeId }: { themeId: string }) {
  const isDark = themeId === 'dark';

  const baseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
  };

  const orbStyle = (style: CSSProperties): CSSProperties => ({
    position: 'absolute',
    borderRadius: 9999,
    filter: 'blur(26px)',
    opacity: isDark ? 0.9 : 1,
    ...style,
  });

  return (
    <div aria-hidden="true" style={baseStyle}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: isDark
            ? 'radial-gradient(circle at 20% 10%, rgba(56, 189, 248, 0.14) 0%, rgba(56, 189, 248, 0) 30%), radial-gradient(circle at 78% 14%, rgba(168, 85, 247, 0.12) 0%, rgba(168, 85, 247, 0) 28%), linear-gradient(180deg, rgba(17, 17, 17, 1) 0%, rgba(11, 11, 14, 1) 100%)'
            : 'radial-gradient(circle at 18% 10%, rgba(96, 165, 250, 0.16) 0%, rgba(96, 165, 250, 0) 32%), radial-gradient(circle at 86% 12%, rgba(125, 211, 252, 0.12) 0%, rgba(125, 211, 252, 0) 30%), linear-gradient(180deg, rgba(245, 240, 235, 1) 0%, rgba(248, 244, 238, 1) 100%)',
        }}
      />
      <div
        style={orbStyle({
          top: -48,
          right: -40,
          width: 220,
          height: 220,
          background: isDark
            ? 'radial-gradient(circle, rgba(52, 211, 153, 0.18) 0%, rgba(52, 211, 153, 0) 72%)'
            : 'radial-gradient(circle, rgba(37, 99, 235, 0.18) 0%, rgba(37, 99, 235, 0) 72%)',
        })}
      />
      <div
        style={orbStyle({
          top: '28%',
          left: -70,
          width: 240,
          height: 240,
          background: isDark
            ? 'radial-gradient(circle, rgba(59, 130, 246, 0.14) 0%, rgba(59, 130, 246, 0) 74%)'
            : 'radial-gradient(circle, rgba(96, 165, 250, 0.16) 0%, rgba(96, 165, 250, 0) 74%)',
        })}
      />
      <div
        style={orbStyle({
          bottom: -56,
          right: '12%',
          width: 260,
          height: 260,
          background: isDark
            ? 'radial-gradient(circle, rgba(244, 114, 182, 0.12) 0%, rgba(244, 114, 182, 0) 72%)'
            : 'radial-gradient(circle, rgba(59, 130, 246, 0.12) 0%, rgba(59, 130, 246, 0) 72%)',
        })}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: isDark
            ? 'linear-gradient(180deg, rgba(17, 17, 17, 0.16) 0%, rgba(17, 17, 17, 0.54) 100%)'
            : 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(245, 240, 235, 0.34) 100%)',
        }}
      />
    </div>
  );
}
