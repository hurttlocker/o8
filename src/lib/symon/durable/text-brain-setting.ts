/**
 * Which brain answers Symon text (#3453).
 *
 * - `auto` (the default): the native planner when one is installed and the
 *   desktop bridge answers, otherwise the built-in Pi brain, so an install
 *   with no agent CLI still answers.
 * - `pi`: always the built-in Pi brain on the managed model.
 * - `planner`: always the native planner, as before this setting existed.
 *
 * The mode is read for each new turn. Earlier turns of a thread reach the Pi
 * brain as data, so a thread can move between brains without losing context.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';

export type SymonTextBrainMode = 'auto' | 'pi' | 'planner';

const MODES: ReadonlySet<string> = new Set(['auto', 'pi', 'planner']);

function settingPath(): string {
  return join(getDataDir(), 'symon', 'text-brain.json');
}

export function isSymonTextBrainMode(value: unknown): value is SymonTextBrainMode {
  return typeof value === 'string' && MODES.has(value);
}

export function readSymonTextBrainMode(): SymonTextBrainMode {
  try {
    const parsed = JSON.parse(readFileSync(settingPath(), 'utf8')) as { mode?: unknown };
    return isSymonTextBrainMode(parsed.mode) ? parsed.mode : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeSymonTextBrainMode(mode: SymonTextBrainMode): SymonTextBrainMode {
  const path = settingPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.text-brain.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ mode }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return readSymonTextBrainMode();
}
