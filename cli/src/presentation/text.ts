import { color } from '../output.js';
import { formatHumanSemanticSurface } from './format.js';
import type { SemanticSurface } from './model.js';

export type SemanticTextWriter = (text: string) => void;

const stdoutWriter: SemanticTextWriter = (text) => {
  process.stdout.write(text);
};

export function renderHumanSemanticSurface(
  surface: SemanticSurface,
  write: SemanticTextWriter = stdoutWriter,
): void {
  write(formatHumanSemanticSurface(surface, (title) => color(title, 'bold')));
}
