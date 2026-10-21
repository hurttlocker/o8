import type { SemanticSurface } from './model.js';

/** Pure shared formatting: no server imports, I/O, or terminal negotiation. */
export function formatHumanSemanticSurface(
  surface: SemanticSurface,
  heading: (text: string) => string = (text) => text,
): string {
  const chunks: string[] = [];
  for (const block of surface.blocks) {
    chunks.push(`\n${heading(block.title)}\n`);
    if (block.kind === 'facts') {
      const width = block.facts.reduce((max, fact) => Math.max(max, fact.label.length), 0);
      for (const fact of block.facts) chunks.push(`${fact.label.padEnd(width)}  ${fact.value}\n`);
    } else {
      for (const event of block.events) {
        chunks.push(`  ${event.timestamp}  ${event.actor.padEnd(13)} ${event.verb}\n`);
      }
    }
  }
  return chunks.join('');
}
