'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  CANVAS_CARD_KINDS,
  CANVAS_FIT_ZOOM,
  CANVAS_ZOOM_STEPS as ZOOM_STEPS,
  closeActiveCanvasCard,
  selectCanvasMedia,
  stepCanvasZoom,
  type CanvasCardKind,
  type CanvasCommands,
} from './canvas-commands';
import { canvasCardTitle, type CanvasCardLite } from './canvas-card-intents';
import { spawnCanvasCard } from './canvas-card-state';
import type { ImageCard } from './image-card';
import type { SnapGeometry } from './canvas-persistence';
import type { DockEntry } from './ui';
import { IMG_MAX_SPAWN_EDGE } from './ui';
import type { useCanvasCards } from './use-canvas-cards';
import type { useCanvasChatCards } from './use-canvas-chat-cards';
import type { useCanvasGrid } from './use-canvas-grid';
import type { useCanvasMediaSpawners } from './use-canvas-media-spawners';
import type { useCanvasSpawners } from './use-canvas-spawners';

const CANVAS_GEOM_FLOOR = 140;

interface MutableRef<T> {
  current: T;
}

type CanvasCards = ReturnType<typeof useCanvasCards>;
type CanvasChatCards = ReturnType<typeof useCanvasChatCards>;
type CanvasGrid = ReturnType<typeof useCanvasGrid>;
type CanvasMediaSpawners = ReturnType<typeof useCanvasMediaSpawners>;
type CanvasSpawners = ReturnType<typeof useCanvasSpawners>;

interface UseCanvasIntentBusDeps extends
  Pick<CanvasCards, 'canvasCardsRef' | 'findCanvasCard' | 'focusCard' | 'imageCardsRef' | 'setImageCards' | 'zPeakRef'>,
  Pick<CanvasChatCards, 'pickThread' | 'redockActiveLane'>,
  Pick<CanvasGrid, 'patchCanvasCardGeom' | 'dismissCanvasCard'>,
  Pick<CanvasMediaSpawners, 'cycleImageCard' | 'spreadImageCard' | 'spawnImageCard' | 'spawnVideoCard'>,
  Pick<CanvasSpawners,
    | 'spawnAgents'
    | 'spawnBrainCard'
    | 'spawnBrowserCard'
    | 'spawnFileCard'
    | 'spawnFileTreeCard'
    | 'spawnMarkdownCard'
    | 'spawnSpecCard'
    | 'spawnWorktreeDiffCard'
  > {
  activeRepoPath: string | null;
  repos: Array<{ name: string; path: string }> | null;
  convos: Record<string, DockEntry[]>;
  canvasEnabled: boolean;
  canvasZoomLevel: number;
  dockOpen: boolean;
  gridMode: boolean;
  pan: { x: number; y: number };
  winSize: { w: number; h: number };
  nextIdRef: MutableRef<number>;
  composerInputRef: MutableRef<HTMLTextAreaElement | null>;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasZoomLevel: Dispatch<SetStateAction<number>>;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  setGridMode: Dispatch<SetStateAction<boolean>>;
  openFilePicker: () => void;
  showCanvasToast: (message: string, tone?: 'error' | 'info' | 'success') => void;
  viewportSpawnOrigin: () => { x: number; y: number };
  spawnTerminal: (cwd: string | null, cwdLabel: string | null, at?: SnapGeometry, opts?: { agentCli?: string }) => void;
  sendPrompt: (prompt: string, attachments?: Array<{ dataUri: string; name?: string }>) => boolean;
  spawnUiLoopProofCard: (value: unknown) => void;
  canvasViewport: (nextZoom?: number, nextPan?: { x: number; y: number }) => { x: number; y: number; w: number; h: number; zoom: number };
  animatePanTo: (target: { x: number; y: number }) => void;
  readCanvasCard: (kind: CanvasCardKind, card: CanvasCardLite, lines: number) => {
    ok: boolean;
    error?: string;
    content?: unknown;
    truncated?: boolean;
  };
}

export function useCanvasIntentBus({
  activeRepoPath,
  repos,
  convos,
  canvasEnabled,
  canvasZoomLevel,
  dockOpen,
  gridMode,
  pan,
  winSize,
  nextIdRef,
  composerInputRef,
  canvasCardsRef,
  findCanvasCard,
  focusCard,
  imageCardsRef,
  setImageCards,
  zPeakRef,
  pickThread,
  redockActiveLane,
  patchCanvasCardGeom,
  dismissCanvasCard,
  cycleImageCard,
  spreadImageCard,
  spawnImageCard,
  spawnVideoCard,
  spawnAgents,
  spawnBrainCard,
  spawnBrowserCard,
  spawnFileCard,
  spawnFileTreeCard,
  spawnMarkdownCard,
  spawnSpecCard,
  spawnWorktreeDiffCard,
  setSessionsOpen,
  setSearchQuery,
  setSearchOpen,
  setCanvasZoomLevel,
  setDockOpen,
  setGridMode,
  openFilePicker,
  showCanvasToast,
  viewportSpawnOrigin,
  spawnTerminal,
  sendPrompt,
  spawnUiLoopProofCard,
  canvasViewport,
  animatePanTo,
  readCanvasCard,
}: UseCanvasIntentBusDeps) {
  const commandPaletteCommands = useMemo<CanvasCommands>(() => ({
    spawnTerminal: () => {
      const path = activeRepoPath ?? null;
      spawnTerminal(path, path ? repos?.find((repo) => repo.path === path)?.name ?? null : null);
    },
    spawnFile: (filePath) => {
      if (filePath) spawnFileCard(filePath);
      else openFilePicker();
    },
    spawnTree: () => {
      if (activeRepoPath) spawnFileTreeCard(activeRepoPath);
      else showCanvasToast('Select a repository to open its file tree.', 'info');
    },
    spawnImage: () => selectCanvasMedia('image', (file) => {
      const origin = viewportSpawnOrigin();
      spawnImageCard(file, { x: origin.x + 140, y: origin.y + 64 });
    }),
    spawnVideo: () => selectCanvasMedia('video', (file) => {
      const origin = viewportSpawnOrigin();
      spawnVideoCard(file, { x: origin.x + 140, y: origin.y + 64 });
    }),
    spawnBrowser: spawnBrowserCard,
    spawnChat: (threadId) => {
      if (threadId) void pickThread(threadId, activeRepoPath);
      else setSessionsOpen(true);
    },
    spawnDiff: () => { void spawnWorktreeDiffCard(); },
    spawnSpec: spawnSpecCard,
    spawnBrain: () => spawnBrainCard(),
    spawnMarkdown: () => spawnMarkdownCard('Note', '# New note'),
    spawnAgent: () => {
      if ((convos[activeRepoPath ?? '']?.length ?? 0) > 0) redockActiveLane();
      composerInputRef.current?.focus();
    },
    openSearch: () => {
      setSearchQuery('');
      setSearchOpen(true);
    },
    closeActiveCard: () => { closeActiveCanvasCard(canvasCardsRef.current, dismissCanvasCard); },
    zoomIn: () => setCanvasZoomLevel((current) => stepCanvasZoom(current, 'in')),
    zoomToFit: () => setCanvasZoomLevel(CANVAS_FIT_ZOOM),
    zoomOut: () => setCanvasZoomLevel((current) => stepCanvasZoom(current, 'out')),
  }), [activeRepoPath, canvasCardsRef, convos, dismissCanvasCard, openFilePicker, pickThread, redockActiveLane, repos, showCanvasToast, spawnBrainCard, spawnBrowserCard, spawnFileCard, spawnFileTreeCard, spawnImageCard, spawnMarkdownCard, spawnSpecCard, spawnTerminal, spawnVideoCard, spawnWorktreeDiffCard, viewportSpawnOrigin]);

  // Canvas intent bus (#1232 phase 2) — Symon and the gated /api/canvas/intent
  // route drive the canvas through the SAME handlers the rail buttons call.
  // Listeners run synchronously on dispatchEvent, so the ack stamped on
  // window.__o8CanvasIntentLast is readable right after dispatch.
  useEffect(() => {
    if (!canvasEnabled) return;
    const onIntent = (event: Event) => {
      const detail = (event as CustomEvent<{ verb?: string; args?: Record<string, unknown>; origin?: string | null }>).detail ?? {};
      const args = (detail.args && typeof detail.args === 'object' ? detail.args : {}) as Record<string, unknown>;
      const origin = detail.origin === 'symon' ? 'symon' : null;
      let ok = true;
      let note: string | null = null;
      let error: string | null = null;
      let data: unknown = undefined;
      try {
        switch (detail.verb) {
          case 'open-browser':
            window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: typeof args.url === 'string' ? args.url : null } }));
            break;
          case 'ask-brain':
            spawnBrainCard(typeof args.question === 'string' ? args.question : undefined);
            break;
          case 'render': {
            // Render-on-screen (#1270) — the orchestrator paints a markdown
            // explainer onto the canvas ("explain X on my screen").
            const title = typeof args.title === 'string' ? args.title.trim() : '';
            const markdown = typeof args.markdown === 'string' ? args.markdown : '';
            if (!markdown.trim()) {
              ok = false;
              note = 'render needs args.markdown';
            } else {
              spawnMarkdownCard(title, markdown);
              note = title ? `rendered "${title}"` : 'rendered note';
            }
            break;
          }
          case 'open-spec':
            spawnSpecCard();
            break;
          case 'spawn-terminal': {
            const path = activeRepoPath ?? null;
            spawnTerminal(path, path ? repos?.find((repo) => repo.path === path)?.name ?? null : null);
            break;
          }
          case 'search':
            setSearchOpen(true);
            if (typeof args.query === 'string') setSearchQuery(args.query);
            break;
          case 'zoom': {
            const level = typeof args.level === 'number' ? args.level : NaN;
            if (ZOOM_STEPS.some((step) => step.value === level)) {
              setCanvasZoomLevel(level);
            } else if (args.direction === 'in' || args.direction === 'out') {
              setCanvasZoomLevel((previous) => stepCanvasZoom(previous, args.direction as 'in' | 'out'));
            } else {
              ok = false;
              note = `zoom needs level (${ZOOM_STEPS.map((step) => step.value).join(', ')}) or direction in|out`;
            }
            break;
          }
          case 'enter':
            // "open / enter / show the canvas" — the route's ensure:true already
            // navigated here before dispatching, so the Canvas is up. Nothing
            // else to do; ack ok so Symon can confirm "the canvas is up".
            break;
          case 'dock':
            if (typeof args.open === 'boolean') setDockOpen(args.open);
            else setDockOpen((previous) => !previous);
            break;
          case 'send-prompt': {
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (!text) {
              ok = false;
              note = 'send-prompt needs args.text';
            } else if (!sendPrompt(text)) {
              ok = false;
              note = 'orchestrator not ready — no repo scoped, busy, or not connected';
            }
            break;
          }
          case 'spawn-agents': {
            // Gateless worktree spawn — "spawn two agents on the auth refactor".
            // The created lanes bloom as numbered cards via the lane watcher.
            const task = typeof args.task === 'string' ? args.task : (typeof args.text === 'string' ? args.text : '');
            const count = typeof args.count === 'number' ? args.count : 1;
            const repo = typeof args.repo === 'string' ? args.repo : null;
            const failure = spawnAgents(task, count, repo, origin);
            if (failure) {
              ok = false;
              note = failure;
            } else {
              const n = Math.max(1, Math.min(5, Math.floor(count) || 1));
              note = `spawning ${n} agent${n === 1 ? '' : 's'}`;
            }
            break;
          }
          case 'grid': {
            // "grid mode" / "tile the agents" — form-fit every canvas card into a
            // grid (the demo's auto-arrange). `on` boolean sets it; omit to toggle.
            // The ack note reflects the RESULTING state (read from the closure) so
            // a spoken toggle never reports the wrong mode back to the operator.
            const explicit = typeof args.on === 'boolean' ? args.on
              : typeof args.enabled === 'boolean' ? args.enabled
              : null;
            const next = explicit === null ? !gridMode : explicit;
            setGridMode(next);
            note = next ? 'grid mode' : 'free canvas';
            break;
          }
          case 'list': {
            // Sight — the canvas card inventory so an agent can act on ids, not
            // pixels. Read from the ref (latest arrays) so this never goes stale.
            const cards: Array<Record<string, unknown>> = [];
            for (const k of CANVAS_CARD_KINDS) {
              for (const c of canvasCardsRef.current[k]) {
                cards.push({ kind: k, id: c.id, x: Math.round(c.x), y: Math.round(c.y), z: c.z, w: Math.round(c.w), h: Math.round(c.h), title: canvasCardTitle(k, c) });
              }
            }
            data = { cards, count: cards.length, zoom: canvasZoomLevel, grid: gridMode, dock: dockOpen, activeRepo: activeRepoPath ?? null, viewport: canvasViewport() };
            note = `${cards.length} card${cards.length === 1 ? '' : 's'} on canvas`;
            break;
          }
          case 'center-on-card':
          case 'read-card': {
            const kind = (typeof args.kind === 'string' ? args.kind : '') as CanvasCardKind;
            const rawId = args.id;
            const id = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' && rawId.trim() ? Number(rawId) : NaN);
            if (!CANVAS_CARD_KINDS.includes(kind) || !Number.isFinite(id)) {
              ok = false;
              error = 'invalid-args';
              note = `${detail.verb} needs args.kind (one of ${CANVAS_CARD_KINDS.join(', ')}) and a numeric args.id — call list first`;
              break;
            }
            const card = findCanvasCard(kind, id);
            if (!card) {
              ok = false;
              error = 'not-found';
              note = 'not-found';
              data = { ok: false, error: 'not-found' };
              break;
            }
            if (detail.verb === 'center-on-card') {
              let nextZoom = canvasZoomLevel;
              const zoomArg = typeof args.zoom === 'number' && Number.isFinite(args.zoom) ? args.zoom : null;
              if (zoomArg !== null) {
                nextZoom = ZOOM_STEPS.reduce((best, step) => (
                  Math.abs(step.value - zoomArg) < Math.abs(best.value - zoomArg) ? step : best
                ), ZOOM_STEPS[0]).value;
                setCanvasZoomLevel(nextZoom);
              }
              animatePanTo({
                x: winSize.w / 2 - (card.x + card.w / 2) * nextZoom,
                y: winSize.h / 2 - (card.y + card.h / 2) * nextZoom,
              });
              data = { ok: true, centered: { kind, id } };
              note = `centered ${kind} ${id}`;
            } else {
              const lines = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.max(1, Math.floor(args.lines)) : 40;
              const read = readCanvasCard(kind, card, lines);
              ok = read.ok;
              error = read.ok ? null : (read.error ?? 'read-card-failed');
              data = read.ok
                ? { ok: true, kind, id, title: canvasCardTitle(kind, card), content: read.content, truncated: read.truncated }
                : { ok: false, kind, id, error: read.error };
              note = read.ok ? `read ${kind} ${id}` : (read.error ?? 'read-card failed');
            }
            break;
          }
          case 'pan': {
            const dx = typeof args.dx === 'number' ? args.dx : null;
            const dy = typeof args.dy === 'number' ? args.dy : null;
            const x = typeof args.x === 'number' ? args.x : null;
            const y = typeof args.y === 'number' ? args.y : null;
            if (dx !== null && dy !== null) {
              const target = { x: pan.x + dx, y: pan.y + dy };
              animatePanTo(target);
              data = { ok: true, viewport: canvasViewport(canvasZoomLevel, target) };
              note = 'panned canvas';
            } else if (x !== null && y !== null) {
              const target = { x, y };
              animatePanTo(target);
              data = { ok: true, viewport: canvasViewport(canvasZoomLevel, target) };
              note = 'panned canvas';
            } else {
              ok = false;
              error = 'invalid-args';
              note = 'pan needs numeric args.dx/dy or numeric args.x/y';
            }
            break;
          }
          case 'move-card':
          case 'resize-card':
          case 'focus-card':
          case 'close-card': {
            // Address a card by (kind, id) — ids come from `list`. Every verb
            // validates the card exists first so an agent gets a clear miss note
            // instead of a silent no-op.
            const kind = (typeof args.kind === 'string' ? args.kind : '') as CanvasCardKind;
            const id = typeof args.id === 'number' ? args.id : Number(args.id);
            if (!CANVAS_CARD_KINDS.includes(kind) || !Number.isFinite(id)) {
              ok = false;
              note = `${detail.verb} needs args.kind (one of ${CANVAS_CARD_KINDS.join(', ')}) and a numeric args.id — call list first`;
              break;
            }
            const card = canvasCardsRef.current[kind].find((c) => c.id === id);
            if (!card) {
              ok = false;
              note = `no ${kind} card with id ${id} on the canvas (call list to see current ids)`;
              break;
            }
            if (detail.verb === 'move-card') {
              const x = Number(args.x);
              const y = Number(args.y);
              if (!Number.isFinite(x) || !Number.isFinite(y)) {
                ok = false;
                note = 'move-card needs numeric args.x and args.y (canvas-layer coordinates)';
                break;
              }
              patchCanvasCardGeom(kind, id, { x, y });
              note = `moved ${kind} ${id} to (${Math.round(x)}, ${Math.round(y)})`;
            } else if (detail.verb === 'resize-card') {
              const w = Number(args.w);
              const h = Number(args.h);
              if (!Number.isFinite(w) || !Number.isFinite(h)) {
                ok = false;
                note = 'resize-card needs numeric args.w and args.h';
                break;
              }
              if ((kind === 'image' || kind === 'video') && card.aspect) {
                // Photos + video stay aspect-locked (like the human resize); honor
                // width and derive height so the agent can't distort the media.
                const nw = Math.max(CANVAS_GEOM_FLOOR, w);
                patchCanvasCardGeom(kind, id, { w: nw, h: Math.round(nw / card.aspect) });
              } else {
                patchCanvasCardGeom(kind, id, { w: Math.max(CANVAS_GEOM_FLOOR, w), h: Math.max(CANVAS_GEOM_FLOOR, h) });
              }
              note = `resized ${kind} ${id}`;
            } else if (detail.verb === 'focus-card') {
              focusCard(kind, id);
              note = `focused ${kind} ${id}`;
            } else {
              dismissCanvasCard(kind, id);
              note = `closed ${kind} ${id}`;
            }
            break;
          }
          case 'add-image': {
            // Put a photo on the canvas from a URL/served path — the verb a voice
            // or agent operator needs (humans drag a File; agents pass a src).
            const src = typeof args.src === 'string' ? args.src : typeof args.url === 'string' ? args.url : '';
            if (!src) { ok = false; note = 'add-image needs args.src (a URL or /served path the canvas can load)'; break; }
            const name = typeof args.name === 'string' ? args.name : (src.split('/').pop() || 'image');
            const ax = typeof args.x === 'number' ? args.x : 80;
            const ay = typeof args.y === 'number' ? args.y : 80;
            const probe = new Image();
            probe.onload = () => {
              const natW = probe.naturalWidth || 1;
              const natH = probe.naturalHeight || 1;
              const aspect = natW / natH;
              const w = natW >= natH ? IMG_MAX_SPAWN_EDGE : Math.round(IMG_MAX_SPAWN_EDGE * aspect);
              const h = Math.round(w / aspect);
              const id = nextIdRef.current;
              nextIdRef.current += 1;
              zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
              setImageCards((prev) => spawnCanvasCard(prev, { id, x: ax, y: ay, z: zPeakRef.current, w, h, aspect, items: [{ src, name }] }));
            };
            probe.src = src;
            note = `adding image ${name}`;
            break;
          }
          case 'ui-loop-proof': spawnUiLoopProofCard(args); note = 'showing UI-loop proof'; break;
          case 'stack': {
            // Group image cards into one deck (the agent twin of drag-together).
            const ids: number[] = Array.isArray(args.ids)
              ? (args.ids as unknown[]).map(Number).filter((n) => Number.isFinite(n))
              : [args.id, args.ontoId].map(Number).filter((n) => Number.isFinite(n));
            const present = ids.filter((id) => imageCardsRef.current.some((c) => c.id === id));
            if (present.length < 2) { ok = false; note = 'stack needs ≥2 existing image ids (args.ids or args.id + args.ontoId — call list for ids)'; break; }
            setImageCards((prev) => {
              const base = prev.find((c) => c.id === present[0]);
              if (!base) return prev;
              const items = present.map((id) => prev.find((c) => c.id === id)).filter((c): c is ImageCard => Boolean(c)).flatMap((c) => c.items);
              const drop = new Set(present.slice(1));
              return prev.filter((c) => !drop.has(c.id)).map((c) => (c.id === base.id ? { ...c, items } : c));
            });
            note = `stacked ${present.length} images`;
            break;
          }
          case 'flip': {
            const id = Number(args.id);
            const deck = imageCardsRef.current.find((c) => c.id === id);
            if (!deck) { ok = false; note = `no image card with id ${id} (call list for ids)`; break; }
            if (deck.items.length < 2) { ok = false; note = `image ${id} isn't a deck (only ${deck.items.length} photo)`; break; }
            const dir = Number(args.dir) < 0 ? -1 : 1;
            cycleImageCard(id, dir);
            note = `flipped deck ${id} to ${dir < 0 ? 'previous' : 'next'}`;
            break;
          }
          case 'separate': {
            const id = Number(args.id);
            const deck = imageCardsRef.current.find((c) => c.id === id);
            if (!deck) { ok = false; note = `no image card with id ${id} (call list for ids)`; break; }
            if (deck.items.length < 2) { ok = false; note = `image ${id} isn't a deck — nothing to separate`; break; }
            spreadImageCard(id);
            note = `separated deck ${id} into ${deck.items.length} cards`;
            break;
          }
          case 'add-file': {
            // Put a repo file on the canvas (CodeMirror editor card). file-io
            // needs an ABSOLUTE path, so reject relative ones with a clear note.
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path) { ok = false; note = 'add-file needs args.path (an absolute file path)'; break; }
            if (!path.startsWith('/')) { ok = false; note = 'add-file path must be absolute (start with /)'; break; }
            const at = (typeof args.x === 'number' && typeof args.y === 'number') ? { x: args.x, y: args.y, w: 620, h: 420 } : undefined;
            spawnFileCard(path, at);
            note = `added file ${path.split('/').pop() || path}`;
            break;
          }
          case 'add-tree': {
            const repo = typeof args.repo === 'string' ? args.repo.trim() : (activeRepoPath ?? '');
            if (!repo) { ok = false; note = 'add-tree needs args.repo when no repository is active'; break; }
            const at = typeof args.x === 'number' && typeof args.y === 'number'
              ? { x: args.x, y: args.y, w: 380, h: 460 }
              : undefined;
            spawnFileTreeCard(repo, at);
            note = `added file tree for ${repo.split('/').filter(Boolean).pop() ?? repo}`;
            break;
          }
          case 'open-diff': {
            // The active repo's working-tree diff ("what have I changed") — the
            // fixture-free diff an agent can always show. Lane diffs go through
            // o8_packet_diff, not here.
            const repo = typeof args.repo === 'string' ? args.repo : (activeRepoPath ?? '');
            if (!repo) { ok = false; note = 'open-diff needs a repo (no active repo scoped — pass args.repo)'; break; }
            void spawnWorktreeDiffCard(undefined, repo);
            note = `opened working-tree diff for ${repo.split('/').filter(Boolean).pop() ?? repo}`;
            break;
          }
          case 'open-chat': {
            // Reopen a past orchestrator thread as a chat card (replays history).
            const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
            if (!threadId) { ok = false; note = 'open-chat needs args.threadId (a past thread id)'; break; }
            const repo = typeof args.repo === 'string' ? args.repo : (activeRepoPath ?? null);
            void pickThread(threadId, repo);
            note = `opened chat thread ${threadId}`;
            break;
          }
          case 'add-video': {
            // Put a video on the canvas from a URL/served path — fetched into a
            // File so it rides the same IndexedDB-backed path as a human drop.
            const src = typeof args.src === 'string' ? args.src.trim() : '';
            if (!src) { ok = false; note = 'add-video needs args.src (a video URL/served path)'; break; }
            const vname = typeof args.name === 'string' ? args.name : (src.split('/').pop() || 'video');
            const vx = typeof args.x === 'number' ? args.x : 320;
            const vy = typeof args.y === 'number' ? args.y : 260;
            void fetch(src)
              .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
              .then((blob) => spawnVideoCard(new File([blob], vname, { type: blob.type || 'video/mp4' }), { x: vx, y: vy }))
              .catch(() => {});
            note = `adding video ${vname}`;
            break;
          }
          default:
            ok = false;
            note = `unknown intent verb: ${String(detail.verb)}`;
        }
      } catch (caught) {
        ok = false;
        error = 'exception';
        note = caught instanceof Error ? caught.message : String(caught);
      }
      (window as unknown as Record<string, unknown>).__o8CanvasIntentLast = { verb: detail.verb ?? null, ok, note, ...(error ? { error } : {}), ...(data !== undefined ? { data } : {}), at: Date.now() };
    };
    window.addEventListener('o8:canvas-intent', onIntent);
    (window as unknown as Record<string, unknown>).__o8CanvasIntentReady = true;
    return () => {
      window.removeEventListener('o8:canvas-intent', onIntent);
      (window as unknown as Record<string, unknown>).__o8CanvasIntentReady = false;
    };
  }, [activeRepoPath, animatePanTo, canvasCardsRef, canvasEnabled, canvasViewport, canvasZoomLevel, dockOpen, findCanvasCard, gridMode, imageCardsRef, pan.x, pan.y, readCanvasCard, repos, sendPrompt, setImageCards, spawnAgents, spawnBrainCard, spawnMarkdownCard, spawnSpecCard, spawnTerminal, spawnFileCard, spawnFileTreeCard, spawnUiLoopProofCard, spawnWorktreeDiffCard, spawnVideoCard, pickThread, cycleImageCard, spreadImageCard, patchCanvasCardGeom, dismissCanvasCard, focusCard, winSize.h, winSize.w, zPeakRef]);
  return commandPaletteCommands;
}
