'use client';

import type { ComponentType } from 'react';
import { LiquidAscii, type LiquidAsciiProps } from './LiquidAscii';

// ── Effects registry ─────────────────────────────────────────────────────────
// This is the "test page" framework. To add another effect (next ReactBits
// recreation, a shader, a loading animation), append one EffectDef below — the
// lab page renders its controls, presets, and stage generically. No page edits.

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export type ControlGroup = 'Simulation' | 'Cursor & Solver' | 'Color';

export type Control =
  | { kind: 'slider'; key: string; label: string; min: number; max: number; step: number; group: ControlGroup }
  | { kind: 'toggle'; key: string; label: string; group: ControlGroup }
  | { kind: 'color'; key: string; label: string; group: ControlGroup };

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  /** Source these props are a 1:1 recreation of (shown as a credit line). */
  source?: string;
  Component: ComponentType<Record<string, unknown>>;
  defaults: Params;
  controls: Control[];
  presets: { name: string; values: Params }[];
}

const liquidAsciiDefaults: Params = {
  speed: 0.9,
  cellSize: 15,
  gravity: -25,
  flipRatio: 0.3,
  pressureIters: 30,
  separationIters: 3,
  overRelaxation: 1.5,
  fillHeight: 0.4,
  cursorRadius: 0.25,
  cursorForce: 66,
  characters: ' ·:-~=+*#%@',
  color: '#ffffff',
  backgroundColor: '#0a0a0a',
  fontFamily: 'monospace',
  opacity: 1,
  autoWave: true,
};

const liquidAscii: EffectDef = {
  id: 'liquid-ascii',
  name: 'Liquid ASCII',
  description: 'A FLIP/PIC fluid simulation rendered as ASCII characters. Move the cursor to push the fluid around.',
  source: 'ReactBits · pro.reactbits.dev/components/liquid-ascii',
  Component: LiquidAscii as ComponentType<Record<string, unknown>>,
  defaults: liquidAsciiDefaults,
  controls: [
    { kind: 'slider', key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, group: 'Simulation' },
    { kind: 'slider', key: 'cellSize', label: 'Cell Size', min: 6, max: 30, step: 1, group: 'Simulation' },
    { kind: 'slider', key: 'gravity', label: 'Gravity', min: -50, max: 0, step: 1, group: 'Simulation' },
    { kind: 'slider', key: 'flipRatio', label: 'FLIP Ratio', min: 0, max: 1, step: 0.05, group: 'Simulation' },
    { kind: 'slider', key: 'fillHeight', label: 'Fill Height', min: 0, max: 1, step: 0.05, group: 'Simulation' },
    { kind: 'slider', key: 'overRelaxation', label: 'Over-Relaxation', min: 1, max: 2, step: 0.05, group: 'Simulation' },
    { kind: 'slider', key: 'cursorRadius', label: 'Cursor Radius', min: 0, max: 0.5, step: 0.01, group: 'Cursor & Solver' },
    { kind: 'slider', key: 'cursorForce', label: 'Cursor Force', min: 0, max: 200, step: 1, group: 'Cursor & Solver' },
    { kind: 'slider', key: 'pressureIters', label: 'Pressure Iters', min: 5, max: 80, step: 1, group: 'Cursor & Solver' },
    { kind: 'slider', key: 'separationIters', label: 'Separation Iters', min: 1, max: 10, step: 1, group: 'Cursor & Solver' },
    { kind: 'toggle', key: 'autoWave', label: 'Auto Wave', group: 'Cursor & Solver' },
    { kind: 'color', key: 'color', label: 'Text Color', group: 'Color' },
    { kind: 'color', key: 'backgroundColor', label: 'Background', group: 'Color' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05, group: 'Color' },
  ],
  presets: [
    { name: 'ReactBits default', values: { ...liquidAsciiDefaults } },
    {
      name: 'o8 amber',
      values: { ...liquidAsciiDefaults, color: '#ff7a18', backgroundColor: '#0a0a0c', flipRatio: 0.25, cursorForce: 90 },
    },
    {
      name: 'Rainwater',
      values: { ...liquidAsciiDefaults, color: '#5ab0ff', backgroundColor: '#06080d', gravity: -32, fillHeight: 0.5 },
    },
    {
      name: 'Zero-g mist',
      values: { ...liquidAsciiDefaults, gravity: 0, flipRatio: 0.6, fillHeight: 0.55, cursorForce: 120, color: '#dfe7ee' },
    },
  ],
};

export const EFFECTS: EffectDef[] = [liquidAscii];

export type { LiquidAsciiProps };
