'use client';

import type { ComponentType } from 'react';
import { LiquidAscii, type LiquidAsciiProps } from './LiquidAscii';
import { AsciiWaveField } from './AsciiWaveField';
import { AsciiFlowField } from './AsciiFlowField';
import { AsciiImage } from './AsciiImage';

// ── Effects registry ─────────────────────────────────────────────────────────
// This is the "test page" framework. To add another effect (next ReactBits
// recreation, a shader, a loading animation), append one EffectDef below — the
// lab page renders its controls, presets, and stage generically. No page edits.

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

// Group is a free string — the page renders one column per distinct group, in
// first-seen order. Common groups: Simulation, Wave, Flow, Source, Cursor, Color.
export type ControlGroup = string;

export type Control =
  | { kind: 'slider'; key: string; label: string; min: number; max: number; step: number; group: ControlGroup }
  | { kind: 'toggle'; key: string; label: string; group: ControlGroup }
  | { kind: 'color'; key: string; label: string; group: ControlGroup }
  | { kind: 'text'; key: string; label: string; group: ControlGroup; placeholder?: string }
  | { kind: 'select'; key: string; label: string; group: ControlGroup; options: { label: string; value: string }[] }
  | { kind: 'upload'; key: string; label: string; group: ControlGroup };

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  /** Source these props are a 1:1 recreation of, or a one-line credit. */
  source?: string;
  Component: ComponentType<Record<string, unknown>>;
  defaults: Params;
  controls: Control[];
  presets: { name: string; values: Params }[];
}

const RAMP = ' ·:-~=+*#%@';
const RAMP_SOFT = ' .:-=+*#%@';

// ── Liquid ASCII (FLIP/PIC fluid — 1:1 ReactBits recreation) ─────────────────
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
  characters: RAMP,
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
  Component: LiquidAscii as unknown as ComponentType<Record<string, unknown>>,
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
    { name: 'o8 amber', values: { ...liquidAsciiDefaults, color: '#ff7a18', backgroundColor: '#0a0a0c', flipRatio: 0.25, cursorForce: 90 } },
    { name: 'Rainwater', values: { ...liquidAsciiDefaults, color: '#5ab0ff', backgroundColor: '#06080d', gravity: -32, fillHeight: 0.5 } },
    { name: 'Zero-g mist', values: { ...liquidAsciiDefaults, gravity: 0, flipRatio: 0.6, fillHeight: 0.55, cursorForce: 120, color: '#dfe7ee' } },
  ],
};

// ── ASCII Image / Wordmark ───────────────────────────────────────────────────
const imageDefaults: Params = {
  cellSize: 12,
  text: 'o8',
  imageSrc: '',
  fit: 'contain',
  invert: false,
  speed: 1,
  baseLevel: 0.5,
  waveBoost: 0.85,
  cursorRipple: 40,
  cursorRadius: 0.25,
  contrast: 1.2,
  characters: RAMP_SOFT,
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

const asciiImage: EffectDef = {
  id: 'ascii-image',
  name: 'ASCII Image',
  description: 'Draw a picture in ASCII — text or an uploaded image — with a wave that washes across to reveal it and cursor ripples. A logo / loading-reveal surface.',
  source: 'o8 experiment',
  Component: AsciiImage as unknown as ComponentType<Record<string, unknown>>,
  defaults: imageDefaults,
  controls: [
    { kind: 'text', key: 'text', label: 'Text', group: 'Source', placeholder: 'o8' },
    { kind: 'upload', key: 'imageSrc', label: 'Image', group: 'Source' },
    { kind: 'select', key: 'fit', label: 'Fit', group: 'Source', options: [
      { label: 'Contain', value: 'contain' },
      { label: 'Cover', value: 'cover' },
    ] },
    { kind: 'toggle', key: 'invert', label: 'Invert', group: 'Source' },
    { kind: 'slider', key: 'cellSize', label: 'Cell Size', min: 6, max: 30, step: 1, group: 'Source' },
    { kind: 'slider', key: 'speed', label: 'Wave Speed', min: 0, max: 3, step: 0.1, group: 'Wave' },
    { kind: 'slider', key: 'baseLevel', label: 'Base Level', min: 0, max: 1, step: 0.05, group: 'Wave' },
    { kind: 'slider', key: 'waveBoost', label: 'Wave Boost', min: 0, max: 2, step: 0.05, group: 'Wave' },
    { kind: 'slider', key: 'contrast', label: 'Contrast', min: 0.5, max: 3, step: 0.1, group: 'Wave' },
    { kind: 'slider', key: 'cursorRipple', label: 'Cursor Ripple', min: 0, max: 100, step: 1, group: 'Cursor' },
    { kind: 'slider', key: 'cursorRadius', label: 'Cursor Radius', min: 0, max: 0.5, step: 0.01, group: 'Cursor' },
    { kind: 'color', key: 'color', label: 'Text Color', group: 'Color' },
    { kind: 'color', key: 'backgroundColor', label: 'Background', group: 'Color' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05, group: 'Color' },
  ],
  presets: [
    { name: 'o8 wordmark', values: { ...imageDefaults } },
    { name: 'o8 amber', values: { ...imageDefaults, color: '#ff7a18', backgroundColor: '#0a0a0c' } },
    { name: 'RAINWATER', values: { ...imageDefaults, text: 'RAINWATER', color: '#5ab0ff', backgroundColor: '#06080d', cellSize: 10 } },
    { name: 'Loading…', values: { ...imageDefaults, text: 'LOADING', baseLevel: 0.35, waveBoost: 1.1, speed: 1.4, cellSize: 11 } },
  ],
};

// ── ASCII Wave Field ─────────────────────────────────────────────────────────
const waveDefaults: Params = {
  cellSize: 13,
  speed: 1,
  waveScale: 1,
  complexity: 3,
  contrast: 1.5,
  cursorWake: 45,
  cursorRadius: 0.28,
  characters: RAMP_SOFT,
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

const asciiWave: EffectDef = {
  id: 'ascii-wave',
  name: 'Wave Field',
  description: 'Flowing interference waves in ASCII with a cursor ripple wake. Ambient background / loading veil.',
  source: 'o8 experiment',
  Component: AsciiWaveField as unknown as ComponentType<Record<string, unknown>>,
  defaults: waveDefaults,
  controls: [
    { kind: 'slider', key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, group: 'Wave' },
    { kind: 'slider', key: 'waveScale', label: 'Scale', min: 0.3, max: 3, step: 0.1, group: 'Wave' },
    { kind: 'slider', key: 'complexity', label: 'Complexity', min: 1, max: 5, step: 1, group: 'Wave' },
    { kind: 'slider', key: 'contrast', label: 'Contrast', min: 0.5, max: 3, step: 0.1, group: 'Wave' },
    { kind: 'slider', key: 'cellSize', label: 'Cell Size', min: 6, max: 30, step: 1, group: 'Wave' },
    { kind: 'slider', key: 'cursorWake', label: 'Cursor Wake', min: 0, max: 100, step: 1, group: 'Cursor' },
    { kind: 'slider', key: 'cursorRadius', label: 'Cursor Radius', min: 0, max: 0.5, step: 0.01, group: 'Cursor' },
    { kind: 'color', key: 'color', label: 'Text Color', group: 'Color' },
    { kind: 'color', key: 'backgroundColor', label: 'Background', group: 'Color' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05, group: 'Color' },
  ],
  presets: [
    { name: 'Default', values: { ...waveDefaults } },
    { name: 'o8 amber', values: { ...waveDefaults, color: '#ff7a18', backgroundColor: '#0a0a0c' } },
    { name: 'Rainwater', values: { ...waveDefaults, color: '#5ab0ff', backgroundColor: '#06080d', waveScale: 1.4 } },
    { name: 'Slow deep', values: { ...waveDefaults, speed: 0.4, contrast: 2.2, waveScale: 0.7, color: '#cfd6dd' } },
  ],
};

// ── ASCII Flow Field ─────────────────────────────────────────────────────────
const flowDefaults: Params = {
  cellSize: 12,
  speed: 0.6,
  density: 0.5,
  trail: 0.86,
  flowScale: 1,
  swirl: 1,
  cursorForce: 32,
  cursorRadius: 0.2,
  characters: RAMP_SOFT,
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

const asciiFlow: EffectDef = {
  id: 'ascii-flow',
  name: 'Flow Field',
  description: 'Glyph particles drifting along a curl-noise flow field, leaving trails. Aurora / data-stream ambient.',
  source: 'o8 experiment',
  Component: AsciiFlowField as unknown as ComponentType<Record<string, unknown>>,
  defaults: flowDefaults,
  controls: [
    { kind: 'slider', key: 'speed', label: 'Speed', min: 0.1, max: 2, step: 0.05, group: 'Flow' },
    { kind: 'slider', key: 'density', label: 'Density', min: 0.05, max: 1, step: 0.05, group: 'Flow' },
    { kind: 'slider', key: 'trail', label: 'Trail', min: 0, max: 0.98, step: 0.02, group: 'Flow' },
    { kind: 'slider', key: 'flowScale', label: 'Flow Scale', min: 0.3, max: 3, step: 0.1, group: 'Flow' },
    { kind: 'slider', key: 'swirl', label: 'Swirl', min: 0.2, max: 3, step: 0.1, group: 'Flow' },
    { kind: 'slider', key: 'cellSize', label: 'Cell Size', min: 6, max: 30, step: 1, group: 'Flow' },
    { kind: 'slider', key: 'cursorForce', label: 'Cursor Force', min: 0, max: 100, step: 1, group: 'Cursor' },
    { kind: 'slider', key: 'cursorRadius', label: 'Cursor Radius', min: 0, max: 0.5, step: 0.01, group: 'Cursor' },
    { kind: 'color', key: 'color', label: 'Text Color', group: 'Color' },
    { kind: 'color', key: 'backgroundColor', label: 'Background', group: 'Color' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05, group: 'Color' },
  ],
  presets: [
    { name: 'Aurora', values: { ...flowDefaults } },
    { name: 'o8 ember', values: { ...flowDefaults, color: '#ff7a18', backgroundColor: '#0a0a0c', trail: 0.9 } },
    { name: 'Rainwater stream', values: { ...flowDefaults, color: '#5ab0ff', backgroundColor: '#06080d', speed: 0.9 } },
    { name: 'Dense weave', values: { ...flowDefaults, density: 0.85, trail: 0.92, swirl: 1.6, color: '#e6e6e9' } },
  ],
};

export const EFFECTS: EffectDef[] = [liquidAscii, asciiImage, asciiWave, asciiFlow];

export type { LiquidAsciiProps };
