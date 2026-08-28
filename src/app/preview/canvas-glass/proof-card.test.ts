// @vitest-environment jsdom

import { createElement, createRef, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageCard } from './image-card';
import { parseUiLoopProofIntent, useUiLoopProofCardSpawner } from './proof-card';

interface HarnessHandle {
  spawn: (value: unknown) => void;
}

const filePath = '/repo/src/save-button.tsx';
const proofArgs = {
  packetId: 'packet-1906',
  laneId: 'lane-1906',
  proofId: 'lane-1906:1787924400000',
  before: { path: '/home/operator/.o8/ui-loop-proofs/lane-1906/proof.before.png', width: 120, height: 36 },
  after: { path: '/home/operator/.o8/ui-loop-proofs/lane-1906/proof.after.png', width: 120, height: 36 },
  previewUrl: 'http://127.0.0.1:4173/preview',
  elapsedMs: 750,
  element: '<button#save>',
  selector: '#save',
  rect: { top: 20, left: 40, width: 120, height: 36 },
  filePath,
};
const findFreeSpot = vi.fn(() => ({ x: 20, y: 30 }));

const Harness = forwardRef<HarnessHandle>(function Harness(_props, ref) {
  const [cards, setCards] = useState<ImageCard[]>([]);
  const canvasCardsRef = useRef({ file: [{ path: filePath, x: 100, y: 200, w: 320 }] });
  const nextIdRef = useRef(7);
  const zPeakRef = useRef(9);
  const spawn = useUiLoopProofCardSpawner(canvasCardsRef, nextIdRef, zPeakRef, setCards, findFreeSpot);
  useImperativeHandle(ref, () => ({ spawn }), [spawn]);
  return createElement('output', null, JSON.stringify(cards));
});

let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  findFreeSpot.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe('UI-loop canvas proof card', () => {
  it('parses the posted proof payload and spawns one deduped BEFORE to AFTER stack beside its file card', async () => {
    expect(parseUiLoopProofIntent(proofArgs)).toMatchObject({
      proofId: proofArgs.proofId,
      element: proofArgs.element,
      filePath,
    });

    const harnessRef = createRef<HarnessHandle>();
    const root = createRoot(container);
    await act(async () => root.render(createElement(Harness, { ref: harnessRef })));
    await act(async () => harnessRef.current?.spawn(proofArgs));

    const first = JSON.parse(container.querySelector('output')?.textContent ?? '[]') as ImageCard[];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 7, x: 444, y: 200, z: 10 });
    expect(first[0]?.items.map((item) => item.name)).toEqual([
      'before · <button#save>',
      'after · <button#save>',
    ]);
    expect(findFreeSpot).not.toHaveBeenCalled();

    await act(async () => harnessRef.current?.spawn(proofArgs));
    const second = JSON.parse(container.querySelector('output')?.textContent ?? '[]') as ImageCard[];
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: first[0]?.id, x: 444, y: 200, z: 11 });
    await act(async () => root.unmount());
  });
});
