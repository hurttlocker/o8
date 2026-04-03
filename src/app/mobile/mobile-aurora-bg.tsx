'use client';

import React from 'react';

const keyframes = `
@keyframes auroraA {
  0%, 100% { transform: translate(0%, 0%) scale(1); }
  33% { transform: translate(15%, -20%) scale(1.1); }
  66% { transform: translate(-10%, 15%) scale(0.95); }
}
@keyframes auroraB {
  0%, 100% { transform: translate(0%, 0%) scale(1.05); }
  33% { transform: translate(-20%, 10%) scale(0.9); }
  66% { transform: translate(10%, -15%) scale(1.1); }
}
@keyframes auroraC {
  0%, 100% { transform: translate(0%, 0%) scale(0.95); }
  33% { transform: translate(12%, 18%) scale(1.05); }
  66% { transform: translate(-15%, -10%) scale(1); }
}
@keyframes grain {
  0%, 100% { transform: translate(0, 0); }
  10% { transform: translate(-2%, -3%); }
  30% { transform: translate(3%, 2%); }
  50% { transform: translate(-1%, 3%); }
  70% { transform: translate(2%, -2%); }
  90% { transform: translate(-3%, 1%); }
}`;

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 0,
  overflow: 'hidden',
  backgroundColor: '#111111',
  pointerEvents: 'none',
};

const orbBase: React.CSSProperties = {
  position: 'absolute',
  borderRadius: '50%',
  filter: 'blur(80px)',
  willChange: 'transform',
};

const orbA: React.CSSProperties = {
  ...orbBase,
  width: '70vmax',
  height: '70vmax',
  top: '-15%',
  left: '-10%',
  background: 'radial-gradient(circle, rgba(45,212,191,0.03) 0%, transparent 70%)',
  animation: 'auroraA 24s ease-in-out infinite',
};

const orbB: React.CSSProperties = {
  ...orbBase,
  width: '65vmax',
  height: '65vmax',
  bottom: '-20%',
  right: '-15%',
  background: 'radial-gradient(circle, rgba(96,165,250,0.04) 0%, transparent 70%)',
  animation: 'auroraB 28s ease-in-out infinite',
};

const orbC: React.CSSProperties = {
  ...orbBase,
  width: '55vmax',
  height: '55vmax',
  top: '40%',
  left: '30%',
  background: 'radial-gradient(circle, rgba(194,116,54,0.025) 0%, transparent 70%)',
  animation: 'auroraC 22s ease-in-out infinite',
};

const grainStyle: React.CSSProperties = {
  position: 'absolute',
  top: '-50%',
  left: '-50%',
  width: '200%',
  height: '200%',
  zIndex: 1,
  opacity: 0.35,
  pointerEvents: 'none',
  backgroundImage: [
    'repeating-conic-gradient(rgba(255,255,255,0.012) 0% 25%, transparent 0% 50%)',
    'repeating-conic-gradient(rgba(0,0,0,0.015) 0% 25%, transparent 0% 50%)',
  ].join(','),
  backgroundSize: '3px 3px, 4px 4px',
  animation: 'grain 8s steps(6) infinite',
};

export function MobileAuroraBg() {
  return (
    <div style={containerStyle}>
      <style dangerouslySetInnerHTML={{ __html: keyframes }} />
      <div style={orbA} />
      <div style={orbB} />
      <div style={orbC} />
      <div style={grainStyle} />
    </div>
  );
}
