'use client';

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
} from 'react';
import { moveCanvasCard, spawnCanvasCard } from '../canvas-card-state';
import { DiffGlassCard, type DiffCard } from '../diff-card';
import { FileGlassCard, type FileCard } from '../file-card';
import { ImageGlassCard, type ImageCard } from '../image-card';
import { MarkdownGlassCard, type MarkdownCard } from '../markdown-card';
import { TerminalGlassCard, type TermCard } from '../terminal-card';

export interface CanvasCardPerfFixture {
  termCards: TermCard[];
  fileCards: FileCard[];
  diffCards: DiffCard[];
  markdownCards: MarkdownCard[];
  imageCards: ImageCard[];
}

export interface CanvasCardPerfHandle {
  moveFirstCard: (frame: number) => void;
  updateFirstDiffCard: () => void;
}

const FIXED_MARKDOWN = [
  '# Canvas performance fixture',
  '',
  'This card uses fixed content so every measurement renders the same tree.',
  '',
  '- terminal cards: 6',
  '- file cards: 6',
  '- diff cards: 3',
  '- markdown cards: 3',
  '- image cards: 2',
].join('\n');

const FIXED_DIFF = [
  'diff --git a/src/canvas.ts b/src/canvas.ts',
  'index 1111111..2222222 100644',
  '--- a/src/canvas.ts',
  '+++ b/src/canvas.ts',
  '@@ -1,3 +1,4 @@',
  ' export const cards = 20;',
  '+export const frameBudget = 16.67;',
  ' export const network = false;',
].join('\n');

const FIXED_IMAGE = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22640%22 height=%22360%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23242a34%22/%3E%3Cpath d=%22M0 280L180 120l110 100 110-80 240 220H0z%22 fill=%22%23586170%22/%3E%3C/svg%3E';

export const CANVAS_CARD_PERF_COUNTS = {
  term: 6,
  file: 6,
  diff: 3,
  markdown: 3,
  image: 2,
  total: 20,
} as const;

export function createCanvasCardPerfFixture(): CanvasCardPerfFixture {
  const fixture: CanvasCardPerfFixture = {
    termCards: [],
    fileCards: [],
    diffCards: [],
    markdownCards: [],
    imageCards: [],
  };
  let id = 1;
  let z = 10;

  for (let index = 0; index < CANVAS_CARD_PERF_COUNTS.term; index += 1) {
    fixture.termCards = spawnCanvasCard(fixture.termCards, {
      id: id++,
      requestId: `perf-terminal-${index + 1}`,
      sessionName: `perf-terminal-${index + 1}`,
      exited: false,
      live: true,
      revealHold: false,
      x: 40 + index * 36,
      y: 60 + index * 28,
      w: 560,
      h: 300,
      z: z++,
      cwd: '/fixture/repo',
      cwdLabel: 'fixture',
    });
  }

  for (let index = 0; index < CANVAS_CARD_PERF_COUNTS.file; index += 1) {
    fixture.fileCards = spawnCanvasCard(fixture.fileCards, {
      id: id++,
      path: `/fixture/repo/src/file-${index + 1}.ts`,
      name: `file-${index + 1}.ts`,
      x: 280 + index * 34,
      y: 120 + index * 26,
      w: 620,
      h: 420,
      z: z++,
    });
  }

  for (let index = 0; index < CANVAS_CARD_PERF_COUNTS.diff; index += 1) {
    fixture.diffCards = spawnCanvasCard(fixture.diffCards, {
      id: id++,
      x: 520 + index * 38,
      y: 180 + index * 30,
      w: 560,
      h: 320,
      z: z++,
      laneId: `perf-lane-${index + 1}`,
      packetId: `perf-packet-${index + 1}`,
      title: `Fixture diff ${index + 1}`,
      branch: `perf/fixture-${index + 1}`,
      stat: '1 file changed, 1 insertion(+)',
      diff: FIXED_DIFF,
      truncated: false,
    });
  }

  for (let index = 0; index < CANVAS_CARD_PERF_COUNTS.markdown; index += 1) {
    fixture.markdownCards = spawnCanvasCard(fixture.markdownCards, {
      id: id++,
      x: 700 + index * 42,
      y: 240 + index * 32,
      w: 380,
      h: 360,
      z: z++,
      title: `Fixture note ${index + 1}`,
      markdown: FIXED_MARKDOWN,
    });
  }

  for (let index = 0; index < CANVAS_CARD_PERF_COUNTS.image; index += 1) {
    fixture.imageCards = spawnCanvasCard(fixture.imageCards, {
      id: id++,
      x: 860 + index * 46,
      y: 300 + index * 34,
      w: 400,
      h: 225,
      z: z++,
      aspect: 16 / 9,
      items: [{ src: FIXED_IMAGE, name: `fixture-${index + 1}.svg` }],
    });
  }

  return fixture;
}

const ignore = (): void => {};

export const CanvasCardPerfHarness = forwardRef<CanvasCardPerfHandle>(function CanvasCardPerfHarness(_props, ref) {
  const [fixture] = useState(createCanvasCardPerfFixture);
  const [termCards, setTermCards] = useState(fixture.termCards);
  const [fileCards] = useState(fixture.fileCards);
  const [diffCards, setDiffCards] = useState(fixture.diffCards);
  const [markdownCards] = useState(fixture.markdownCards);
  const [imageCards] = useState(fixture.imageCards);

  const moveTermCard = useCallback((cardId: number, x: number, y: number) => {
    setTermCards((previous) => moveCanvasCard(previous, cardId, x, y));
  }, []);

  useImperativeHandle(ref, () => ({
    moveFirstCard(frame) {
      moveTermCard(termCards[0]!.id, 40 + frame * 3, 60 + frame * 2);
    },
    updateFirstDiffCard() {
      setDiffCards((previous) => previous.map((card, index) => index === 0 ? { ...card, stat: '2 files changed' } : card));
    },
  }), [moveTermCard, termCards]);

  return (
    <div>
      {termCards.map((card) => (
        <TerminalGlassCard
          key={`term:${card.id}`}
          card={card}
          termVeil={0.52}
          connectionEpoch={0}
          onMove={moveTermCard}
          onResize={ignore}
          onFocus={ignore}
          onClose={ignore}
          onTermVeilChange={ignore}
          registerHandle={ignore}
          sendTerminalAttach={ignore}
          sendTerminalInput={ignore}
          sendTerminalResize={ignore}
          sendTerminalDetach={ignore}
        />
      ))}
      {fileCards.map((card) => (
        <FileGlassCard key={`file:${card.id}`} card={card} termVeil={0.52} onMove={ignore} onResize={ignore} onFocus={ignore} onClose={ignore} />
      ))}
      {diffCards.map((card) => (
        <DiffGlassCard key={`diff:${card.id}`} card={card} onMove={ignore} onResize={ignore} onFocus={ignore} onClose={ignore} onRequestChanges={ignore} onRefresh={ignore} onChanged={ignore} />
      ))}
      {markdownCards.map((card) => (
        <MarkdownGlassCard key={`markdown:${card.id}`} card={card} onMove={ignore} onResize={ignore} onFocus={ignore} onClose={ignore} />
      ))}
      {imageCards.map((card) => (
        <ImageGlassCard
          key={`image:${card.id}`}
          card={card}
          isDropTarget={false}
          onMove={ignore}
          onResize={ignore}
          onFocus={ignore}
          onDrop={ignore}
          onTap={ignore}
          onCycle={ignore}
          onSpread={ignore}
          onClose={ignore}
        />
      ))}
    </div>
  );
});
