'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { animate } from 'framer-motion';
import { usableCanvasArea } from './canvas-drag';
import { carveChrome, chromeRectsCanvas } from './chrome-rects';
import { computeGrid, slotToCardGeom, type GridItem, type Slot } from './form-fit';
import type { MinimapCard } from './navigator-loupe';
import { canvasZoom } from './ui';
import type { CanvasCardKind } from './canvas-commands';
import type { TermCard } from './terminal-card';
import type { LaneRow } from './use-canvas-spawners';
import type { useCanvasCards } from './use-canvas-cards';

const GRID_MODE_KEY = 'o8:canvas-grid-mode';

interface MutableRef<T> {
  current: T;
}

type CanvasCards = ReturnType<typeof useCanvasCards>;
type CardDeps = Pick<CanvasCards,
  | 'termCards' | 'setTermCards'
  | 'fileCards' | 'setFileCards'
  | 'treeCards' | 'setTreeCards'
  | 'imageCards' | 'setImageCards'
  | 'videoCards' | 'setVideoCards'
  | 'browserCards' | 'setBrowserCards'
  | 'chatCards' | 'setChatCards'
  | 'diffCards' | 'setDiffCards'
  | 'specCards' | 'setSpecCards'
  | 'brainCards' | 'setBrainCards'
  | 'markdownCards' | 'setMarkdownCards'
  | 'agentCards' | 'setAgentCards'
  | 'canvasCardsRef'
>;

interface UseCanvasGridDeps extends CardDeps {
  gridMode: boolean;
  setGridMode: Dispatch<SetStateAction<boolean>>;
  winSize: { w: number; h: number };
  setWinSize: Dispatch<SetStateAction<{ w: number; h: number }>>;
  pan: { x: number; y: number };
  setPan: Dispatch<SetStateAction<{ x: number; y: number }>>;
  panRef: MutableRef<{ x: number; y: number }>;
  canvasZoomLevel: number;
  dockOpen: boolean;
  activeLanes: LaneRow[];
  dockTrayExpanded: boolean;
  gridItemsRef: MutableRef<Array<GridItem & { x: number; y: number; w: number; h: number }>>;
  gridAnimRef: MutableRef<{ stop: () => void } | null>;
  setGridPlaceholder: Dispatch<SetStateAction<Slot | null>>;
  closeTerminal: (card: TermCard) => void;
  closeFileCard: (id: number) => void;
  closeTreeCard: (id: number) => void;
  closeImageCard: (id: number) => void;
  closeVideoCard: (id: number) => void;
  closeBrowserCard: (id: number) => void;
  closeChatCard: (id: number) => void;
}

export function useCanvasGrid({
  termCards,
  setTermCards,
  fileCards,
  setFileCards,
  treeCards,
  setTreeCards,
  imageCards,
  setImageCards,
  videoCards,
  setVideoCards,
  browserCards,
  setBrowserCards,
  chatCards,
  setChatCards,
  diffCards,
  setDiffCards,
  specCards,
  setSpecCards,
  brainCards,
  setBrainCards,
  markdownCards,
  setMarkdownCards,
  agentCards,
  setAgentCards,
  canvasCardsRef,
  gridMode,
  setGridMode,
  winSize,
  setWinSize,
  pan,
  setPan,
  panRef,
  canvasZoomLevel,
  dockOpen,
  activeLanes,
  dockTrayExpanded,
  gridItemsRef,
  gridAnimRef,
  setGridPlaceholder,
  closeTerminal,
  closeFileCard,
  closeTreeCard,
  closeImageCard,
  closeVideoCard,
  closeBrowserCard,
  closeChatCard,
}: UseCanvasGridDeps) {
  // ── Form-fit grid (#1239) — pack every card into a viewport-filling grid.
  // A ref mirror of all card geometry keeps applyGridLayout's identity stable so
  // the trigger effect below never loops on the layout's own per-frame writes.
  useEffect(() => {
    gridItemsRef.current = [
      ...termCards.map((c) => ({ kind: 'term', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...fileCards.map((c) => ({ kind: 'file', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...treeCards.map((c) => ({ kind: 'tree', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...imageCards.map((c) => ({ kind: 'image', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...browserCards.map((c) => ({ kind: 'browser', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...chatCards.map((c) => ({ kind: 'chat', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...diffCards.map((c) => ({ kind: 'diff', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...specCards.map((c) => ({ kind: 'spec', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...brainCards.map((c) => ({ kind: 'brain', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...markdownCards.map((c) => ({ kind: 'markdown', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...agentCards.map((c) => ({ kind: 'agent', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
    ];
  }, [termCards, fileCards, treeCards, imageCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  // Animate id→geom across all 8 card arrays with the ~180ms ease-out settle.
  const writeGridTargets = useCallback((targets: Map<number, { x: number; y: number; w: number; h: number }>) => {
    gridAnimRef.current?.stop();
    const starts = new Map(gridItemsRef.current.map((it) => [it.id, { x: it.x, y: it.y, w: it.w, h: it.h }]));
    const lerp = <T extends { id: number; x: number; y: number; w: number; h: number }>(card: T, t: number): T => {
      const s = starts.get(card.id);
      const e = targets.get(card.id);
      if (!s || !e) return card;
      // Only touch a dimension that actually changes — a pure reorder keeps the
      // cell size, so rewriting w/h every frame would needlessly churn the card
      // bodies (terminals re-fit on size change → render storms).
      const next = { ...card, x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t };
      if (Math.abs(e.w - s.w) > 1) next.w = Math.round(s.w + (e.w - s.w) * t);
      if (Math.abs(e.h - s.h) > 1) next.h = Math.round(s.h + (e.h - s.h) * t);
      return next;
    };
    const writeAll = (t: number) => {
      setTermCards((p) => p.map((c) => lerp(c, t)));
      setFileCards((p) => p.map((c) => lerp(c, t)));
      setTreeCards((p) => p.map((c) => lerp(c, t)));
      setImageCards((p) => p.map((c) => lerp(c, t)));
      setBrowserCards((p) => p.map((c) => lerp(c, t)));
      setChatCards((p) => p.map((c) => lerp(c, t)));
      setDiffCards((p) => p.map((c) => lerp(c, t)));
      setSpecCards((p) => p.map((c) => lerp(c, t)));
      setBrainCards((p) => p.map((c) => lerp(c, t)));
      setMarkdownCards((p) => p.map((c) => lerp(c, t)));
      setAgentCards((p) => p.map((c) => lerp(c, t)));
    };
    gridAnimRef.current = animate(0, 1, { duration: 0.18, ease: [0.22, 0.61, 0.36, 1], onUpdate: writeAll });
  }, [setAgentCards, setBrainCards, setBrowserCards, setChatCards, setDiffCards, setFileCards, setImageCards, setMarkdownCards, setSpecCards, setTermCards, setTreeCards]);

  // Core form-fit layout — pack `order` (card ids) into grid slots filling the
  // usable area minus a gap-margin (so the grid sits off the dock/rails/composer),
  // then animate everyone into place. Real chrome is measured per card so TOTAL
  // heights match the slot (no overlap, symmetric rows).
  const layoutGrid = useCallback((order: number[]) => {
    if (order.length === 0) return;
    const zoom = canvasZoom();
    const gap = 26 / zoom;
    const raw = usableCanvasArea();
    // Half-gap margin (the static insets already clear the rails/composer/dock) —
    // fills the field more generously so grid cells read bigger by default.
    const inset = { x: raw.x + gap / 2, y: raw.y + gap / 2, w: raw.w - gap, h: raw.h - gap };
    // Carve any FLOATING chrome the insets don't cover (the review picker) so
    // tiles never pack under it. Grid mode pins pan at origin, so panRef is (0,0).
    const area = carveChrome(inset, chromeRectsCanvas(panRef.current, zoom));
    if (area.w < 120 || area.h < 120) return;
    const byId = new Map(gridItemsRef.current.map((it) => [it.id, it]));
    // Pack with the REAL card kinds (index-keyed to `order`) so each tile takes
    // its kind's aspect — terminals land wider than agent tiles.
    const slotMap = computeGrid(order.map((id, i) => ({ id: i, kind: byId.get(id)?.kind ?? 'x' })), area, gap);
    const chromeOf = (id: number): number | undefined => {
      const it = byId.get(id);
      const el = typeof document !== 'undefined' ? document.querySelector(`[data-card-id="${id}"]`) : null;
      if (el instanceof HTMLElement && it) {
        // Chrome = rendered total − stored body `it.h`, measured with
        // `offsetHeight` (NOT getBoundingClientRect). Two reasons:
        //  1. A freshly-spawned card mounts under a motion spring
        //     (transform: scale .7→1); bcr reflects that transient scale, so
        //     measuring mid-mount handed back a shrunk height → bogus chrome →
        //     the card landed at the wrong size ("glitchy most times").
        //     offsetHeight is pure LAYOUT and ignores the transform.
        //  2. offsetHeight is already in LAYOUT px (CSS `zoom` isn't applied by
        //     this WebKit), the same space as the stored body `it.h`.
        // Accept chrome === 0 (>= 0): image/video cards bind height on the root
        // (root === body), so their chrome is genuinely 0. The old `c > 0` test
        // rejected that and fell through to the per-kind estimate (image: 28),
        // leaving photo/video cards a chrome-height SHORT of their cell — the
        // dead gap + outlined "wonky" tiles the operator saw. Now they fill the
        // full grid cell like every borderless shell card.
        //
        // Coordinate space: `it.h` and the slot are LAYER units. In-layer cards
        // sit under the canvas CSS-zoom layer, whose zoom this WebKit does NOT
        // fold into offsetHeight, so their offsetHeight is already layer units.
        // The o8.md spec card is the one card rendered OUT of that layer
        // (screenMap, so CodeMirror's caret hit-tests at device 1:1), so ITS
        // offsetHeight is real screen px = layerHeight × zoom. Difference the two
        // spaces and the chrome comes out garbage at any zoom ≠ 1 (negative →
        // wrong fallback, or wildly inflated → the card mis-sizes past its slot).
        // Divide the out-of-layer card back to layer units first.
        const layerHeight = it.kind === 'spec' ? el.offsetHeight / zoom : el.offsetHeight;
        const c = layerHeight - it.h;
        if (c >= 0 && c < 400) return c;
      }
      return undefined;
    };
    const targets = new Map<number, { x: number; y: number; w: number; h: number }>();
    order.forEach((id, i) => {
      const slot = slotMap.get(i);
      if (!slot) return;
      targets.set(id, slotToCardGeom(slot, byId.get(id)?.kind ?? 'x', chromeOf(id)));
    });
    writeGridTargets(targets);
  }, [writeGridTargets]);

  // Reading order (top→bottom, left→right) keeps the grid near each card's
  // current spot, so a reflow reads as "tidy", not "shuffle".
  const applyGridLayout = useCallback(() => {
    const order = [...gridItemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);
    layoutGrid(order);
  }, [layoutGrid]);

  // Restore the persisted mode + track window size for grid re-fits.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(GRID_MODE_KEY) === '1') setGridMode(true);
    } catch {
      // non-critical
    }
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Re-grid on: entering grid mode, card add/remove, resize, zoom, dock open/close
  // (the dock reserves right-side space, so the grid must re-pack clear of it).
  // Keyed on a COUNT signature (not the arrays) so the layout's own writes don't
  // re-trigger. dockOpen's --cnv-dock-reserve stamp effect is declared earlier, so
  // it lands before this reads usableCanvasArea().
  const gridCardCount =
    termCards.length + fileCards.length + treeCards.length + imageCards.length + browserCards.length +
    chatCards.length + diffCards.length + specCards.length + brainCards.length + markdownCards.length +
    agentCards.length;

  // Navigator loupe minimap (#1239) — every card as a scaled rect; image cards
  // carry their thumbnail. The usable area is the minimap's stable frame.
  const minimapCards = useMemo<MinimapCard[]>(() => [
    ...termCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'term' })),
    ...fileCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'file' })),
    ...treeCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'tree' })),
    ...imageCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'image', src: c.items[0]?.src })),
    ...videoCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'video', src: c.poster })),
    ...browserCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'browser' })),
    ...chatCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'chat' })),
    ...diffCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'diff' })),
    ...specCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'spec' })),
    ...brainCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'brain' })),
    ...markdownCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'markdown' })),
  ], [termCards, fileCards, treeCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards]);
  // The navigator frames a region ~1.25× the viewport, CENTERED on where you're
  // looking (pan). Framing a bit MORE than the viewport keeps each card a small
  // tile (several tiling the sphere, reference-style) rather than 2-3 big cards
  // filling it. Uses canvasZoomLevel directly (not the lagged stamp).
  const loupeArea = useMemo(() => {
    const zoom = canvasZoomLevel || 1;
    const vw = winSize.w;
    const vh = winSize.h;
    const viewCenterX = (vw / 2 - pan.x) / zoom;
    const viewCenterY = (vh / 2 - pan.y) / zoom;
    const regionW = (vw / zoom) * 1.25;
    const regionH = (vh / zoom) * 1.25;
    return { x: viewCenterX - regionW / 2, y: viewCenterY - regionH / 2, w: regionW, h: regionH };
  }, [winSize.w, winSize.h, canvasZoomLevel, pan.x, pan.y]);

  useEffect(() => {
    if (!gridMode) return;
    // Defer past the commit + debounce rapid re-triggers: snapshot restore mounts
    // the cards across several renders, and applyGridLayout's per-frame animation
    // setState must never re-enter this effect synchronously (→ "maximum update
    // depth"). One rAF after the render storm settles applies the layout once.
    const raf = requestAnimationFrame(() => applyGridLayout());
    // The bottom DispatchDock tray appears + expands/collapses with a ~220ms
    // height animation; the rAF above would measure it mid-flight and under-
    // reserve. Re-pack once more after it settles so the grid ends above the tray
    // at its FINAL height. Cheap (layout is fast); harmless for the other triggers.
    const settle = window.setTimeout(() => applyGridLayout(), 260);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(settle); };
    // activeLanes.length = tray visibility, dockTrayExpanded = its expanded state
    // (both change the reserved bottom stack height, same role as dockOpen).
  }, [gridMode, gridCardCount, winSize.w, winSize.h, canvasZoomLevel, dockOpen, activeLanes.length, dockTrayExpanded, applyGridLayout]);

  // Grid mode packs to the viewport — snap the pan back to origin so the grid
  // lands centered, not wherever you'd roamed.
  useEffect(() => {
    if (gridMode) setPan({ x: 0, y: 0 });
  }, [gridMode]);

  // Two-finger scroll pans the infinite canvas (free mode only), over the canvas
  // background — cards keep their own content scroll, chrome is untouched. Window
  // listener (not onWheel) so it fires reliably + can preventDefault. `pan` is a
  // SCREEN-px offset (WebKit `transform: translate` on a `zoom` layer is NOT
  // scaled by the zoom), so the scroll delta maps 1:1.
  useEffect(() => {
    if (gridMode) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('[data-canvas-layer]')) return;
      if (target.closest('[data-card-id]')) return;
      event.preventDefault();
      setPan((prev) => ({ x: prev.x - event.deltaX, y: prev.y - event.deltaY }));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [gridMode]);

  useEffect(() => {
    // Stamp the mode so canvas-drag's dragBounds knows whether to fence (grid) or
    // roam (free / infinite canvas).
    document.documentElement.style.setProperty('--cnv-grid', gridMode ? '1' : '0');
    try {
      window.localStorage.setItem(GRID_MODE_KEY, gridMode ? '1' : '0');
    } catch {
      // non-critical
    }
  }, [gridMode]);

  // Grid drag-to-reorder with LIVE placeholder (the reference feel): pick a card
  // up (it floats free via its own drag), the others reflow INSTANTLY to open a
  // hole where it will land, a ghost slot marks the spot, and on drop everyone
  // settles with the ease. No per-card wiring — the lifted card is identified by
  // its data-card-id under the pointer; its live center picks the target slot.
  useEffect(() => {
    if (!gridMode) return;
    let drag: { id: number; order: number[]; lastIndex: number; placed: boolean } | null = null;
    // Coalesce the reflow to one per animation frame: pointermove fires far faster
    // than we want to re-pack, and deferring the setState to rAF keeps it off the
    // render/commit path (no "maximum update depth" under a fast drag).
    let reflowRaf = 0;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) { drag = null; return; }
      const el = (event.target as HTMLElement | null)?.closest?.('[data-card-id]');
      if (!el) { drag = null; return; }
      const id = Number(el.getAttribute('data-card-id'));
      const order = [...gridItemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);
      const idx = order.indexOf(id);
      if (idx < 0) { drag = null; return; }
      drag = { id, order, lastIndex: idx, placed: false };
    };

    const onMove = () => {
      if (!drag || reflowRaf) return;
      reflowRaf = requestAnimationFrame(() => {
        reflowRaf = 0;
        if (!drag) return;
        const liftedEl = document.querySelector(`[data-card-id="${drag.id}"]`);
        if (!liftedEl) return;
        const zoom = canvasZoom();
        const r = liftedEl.getBoundingClientRect();
        const cx = (r.left + r.width / 2) / zoom;
        const cy = (r.top + r.height / 2) / zoom;
        const gap = 26 / zoom;
        const raw = usableCanvasArea();
        // Same packing area as layoutGrid — half-gap inset, then carve floating
        // chrome — so the drag placeholder lands exactly where the drop will.
        const inset = { x: raw.x + gap / 2, y: raw.y + gap / 2, w: raw.w - gap, h: raw.h - gap };
        const area = carveChrome(inset, chromeRectsCanvas(panRef.current, zoom));
        const kindOf = new Map(gridItemsRef.current.map((it) => [it.id, it.kind]));
        const slotMap = computeGrid(drag.order.map((id, i) => ({ id: i, kind: kindOf.get(id) ?? 'x' })), area, gap);
        let targetIndex = drag.lastIndex;
        let best = Infinity;
        for (let i = 0; i < drag.order.length; i += 1) {
          const s = slotMap.get(i);
          if (!s) continue;
          const dx = s.x + s.w / 2 - cx;
          const dy = s.y + s.h / 2 - cy;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; targetIndex = i; }
        }
        if (drag.placed && targetIndex === drag.lastIndex) return; // ghost already here
        drag.lastIndex = targetIndex;
        drag.placed = true;
        // Show the ghost where the card will land — but DON'T reflow the other cards
        // mid-drag. Re-rendering the heavy card bodies (terminals/chats) every reflow
        // frame trips their own effects' update-depth guard under StrictMode. Only
        // the lightweight placeholder updates here (the others keep unchanged props,
        // so React skips re-rendering them); everything re-packs on drop.
        const slotArr: Slot[] = [];
        for (let i = 0; i < drag.order.length; i += 1) {
          const s = slotMap.get(i);
          if (s) slotArr.push(s);
        }
        setGridPlaceholder(slotArr[targetIndex] ?? null);
      });
    };

    const onUp = () => {
      if (reflowRaf) { cancelAnimationFrame(reflowRaf); reflowRaf = 0; }
      if (drag && drag.placed) {
        const others = drag.order.filter((other) => other !== drag!.id);
        const finalOrder = [...others];
        finalOrder.splice(drag.lastIndex, 0, drag.id); // lifted lands at the placeholder
        layoutGrid(finalOrder);
      }
      setGridPlaceholder(null);
      drag = null;
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp);
      if (reflowRaf) cancelAnimationFrame(reflowRaf);
      setGridPlaceholder(null);
    };
  }, [gridMode, layoutGrid]);

  const patchCanvasCardGeom = useCallback((kind: CanvasCardKind, id: number, patch: { x?: number; y?: number; w?: number; h?: number }) => {
    switch (kind) {
      case 'term': setTermCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'file': setFileCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'tree': setTreeCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'image': setImageCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'video': setVideoCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'browser': setBrowserCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'chat': setChatCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'diff': setDiffCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'spec': setSpecCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'brain': setBrainCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'markdown': setMarkdownCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'agent': setAgentCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
    }
  }, [setAgentCards, setBrainCards, setBrowserCards, setChatCards, setDiffCards, setFileCards, setImageCards, setMarkdownCards, setSpecCards, setTermCards, setTreeCards, setVideoCards]);

  const dismissCanvasCard = useCallback((kind: CanvasCardKind, id: number) => {
    switch (kind) {
      case 'term': {
        const card = canvasCardsRef.current.term.find((c) => c.id === id);
        if (card) closeTerminal(card as unknown as TermCard);
        break;
      }
      case 'file': closeFileCard(id); break;
      case 'tree': closeTreeCard(id); break;
      case 'image': closeImageCard(id); break;
      case 'video': closeVideoCard(id); break;
      case 'browser': closeBrowserCard(id); break;
      case 'chat': closeChatCard(id); break;
      case 'diff': setDiffCards((p) => p.filter((c) => c.id !== id)); break;
      case 'spec': setSpecCards((p) => p.filter((c) => c.id !== id)); break;
      case 'brain': setBrainCards((p) => p.filter((c) => c.id !== id)); break;
      case 'markdown': setMarkdownCards((p) => p.filter((c) => c.id !== id)); break;
      case 'agent': setAgentCards((p) => p.filter((c) => c.id !== id)); break;
    }
  }, [canvasCardsRef, closeTerminal, closeFileCard, closeTreeCard, closeImageCard, closeVideoCard, closeBrowserCard, closeChatCard, setAgentCards, setBrainCards, setDiffCards, setMarkdownCards, setSpecCards]);

  return { minimapCards, loupeArea, patchCanvasCardGeom, dismissCanvasCard };
}
