import { color } from '../output.js';
import type { SemanticSurface } from './model.js';

export type SemanticTextWriter = (text: string) => void;

const stdoutWriter: SemanticTextWriter = (text) => {
  process.stdout.write(text);
};

export function renderHumanSemanticSurface(
  surface: SemanticSurface,
  write: SemanticTextWriter = stdoutWriter,
): void {
  for (const block of surface.blocks) {
    write(`\n${color(block.title, 'bold')}\n`);

    if (block.kind === 'facts') {
      const maxKey = block.facts.reduce((max, fact) => Math.max(max, fact.label.length), 0);
      for (const fact of block.facts) {
        write(`${fact.label.padEnd(maxKey)}  ${fact.value}\n`);
      }
      continue;
    }

    for (const event of block.events) {
      write(`  ${event.timestamp}  ${event.actor.padEnd(13)} ${event.verb}\n`);
    }
  }
}
