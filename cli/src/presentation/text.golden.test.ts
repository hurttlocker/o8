import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPacketInfoSurface } from '../commands/packet/info-surface.js';
import { renderHumanSemanticSurface } from './text.js';

// Today's `o8 packet info` human output, pinned. The Tern lab's text fallback is
// checked against the same files, so neither side can drift alone.
const fixtureUrl = new URL('../../experiments/tern/packet.fixture.json', import.meta.url);
const goldenUrl = (variant: 'plain' | 'tty') =>
  new URL(`../../experiments/tern/golden/packet-info.${variant}.txt`, import.meta.url);

function render(isTTY: boolean): string {
  const { packet } = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  let text = '';
  renderHumanSemanticSurface(buildPacketInfoSurface({ ...packet, packetId: packet.id }), (chunk) => {
    text += chunk;
  });
  return text;
}

describe('packet info human output golden', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  afterEach(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  for (const [variant, isTTY] of [['plain', false], ['tty', true]] as const) {
    it(`matches the ${variant} golden byte for byte`, () => {
      const text = render(isTTY);
      if (process.env.O8_UPDATE_GOLDEN === '1') writeFileSync(goldenUrl(variant), text);
      expect(text).toBe(readFileSync(goldenUrl(variant), 'utf8'));
    });
  }
});
