'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { animate } from 'framer-motion';
import { codename } from '@/lib/agents/codename';
import { AGENT_FULL_H, AGENT_FULL_W, type AgentCard } from './agent-card';
import type { BrainCard } from './brain-card';
import type { BrowserCard, BrowserTab } from './browser-card';
import type { CanvasCardLite } from './canvas-card-intents';
import { spawnCanvasCard } from './canvas-card-state';
import type { DiffCard } from './diff-card';
import type { FileCard } from './file-card';
import type { FileTreeCard } from './file-tree-card';
import type { MarkdownCard } from './markdown-card';
import type { SnapGeometry } from './canvas-persistence';
import type { SpecCard } from './spec-card';
import { spawnCanvasAgents } from './spawn-prompt-client';
import { CARD_ENTRANCE } from './ui';
import { fetchWorktreeDiff, findFileRepoPath, worktreeDiffCardFromData, worktreeRepoPath } from './worktree-diff';

const SPAWN_CHOREOGRAPHY_TTL_MS = 20_000;

export type SpawnChoreography = {
  repoPath: string;
  origin: { x: number; y: number };
  delayMs: number;
  expiresAt: number;
};

export type SpawnReservation = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export interface LaneRow {
  id: string;
  packetId?: string | null;
  /** Warm-session key — the transcript fallback when packetId can't resolve. */
  sessionKey?: string | null;
  label?: string | null;
  repoPath?: string | null;
  status?: string | null;
  runtime?: string | null;
  /** Lane creation (ISO) — the agent card's elapsed-timer origin. */
  createdAt?: string | null;
  /** Last write (ISO) — freeze point for a settled agent card's ran-duration. */
  updatedAt?: string | null;
  /** Last event (ISO) — preferred freeze point (the moment work last moved). */
  lastEventAt?: string | null;
}

interface MutableRef<T> {
  current: T;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface UseCanvasSpawnersDeps {
  activeRepoPath: string | null;
  repos: Array<{ path: string }> | null;
  specCards: SpecCard[];
  brainCards: BrainCard[];
  nextIdRef: MutableRef<number>;
  zPeakRef: MutableRef<number>;
  timersRef: MutableRef<Array<ReturnType<typeof setTimeout>>>;
  symonSpawnPacketIdsRef: MutableRef<Set<string>>;
  symonSpawnWindowUntilRef: MutableRef<number>;
  agentNumberRef: MutableRef<number>;
  agentAnchorsRef: MutableRef<{
    last: { x: number; y: number } | null;
    byRepo: Map<string, { x: number; y: number }>;
  }>;
  spawnChoreographyRef: MutableRef<SpawnChoreography[]>;
  spawnReservationsRef: MutableRef<SpawnReservation[]>;
  setAgentCards: StateSetter<AgentCard[]>;
  setDiffCards: StateSetter<DiffCard[]>;
  setSpecCards: StateSetter<SpecCard[]>;
  setBrainCards: StateSetter<BrainCard[]>;
  setMarkdownCards: StateSetter<MarkdownCard[]>;
  setBrowserCards: StateSetter<BrowserCard[]>;
  setFileCards: StateSetter<FileCard[]>;
  setTreeCards: StateSetter<FileTreeCard[]>;
  setFilePathPickerOpen: StateSetter<boolean>;
  setFilePathInput: StateSetter<string>;
  findFreeSpot: (w: number, h: number, anchor?: { x: number; y: number } | null) => { x: number; y: number };
  reducedMotion: () => boolean;
  takeSpawnChoreography: () => SpawnChoreography | null;
  viewportSpawnOrigin: () => { x: number; y: number };
  refreshLanes: () => void;
  focusSpecCard: (id: number) => void;
  focusBrainCard: (id: number) => void;
  showCanvasToast: (message: string, tone?: 'error' | 'info' | 'success') => void;
  getCanvasDiffCards: () => CanvasCardLite[];
}

export function useCanvasSpawners({
  activeRepoPath,
  repos,
  specCards,
  brainCards,
  nextIdRef,
  zPeakRef,
  timersRef,
  symonSpawnPacketIdsRef,
  symonSpawnWindowUntilRef,
  agentNumberRef,
  agentAnchorsRef,
  spawnChoreographyRef,
  spawnReservationsRef,
  setAgentCards,
  setDiffCards,
  setSpecCards,
  setBrainCards,
  setMarkdownCards,
  setBrowserCards,
  setFileCards,
  setTreeCards,
  setFilePathPickerOpen,
  setFilePathInput,
  findFreeSpot,
  reducedMotion,
  takeSpawnChoreography,
  viewportSpawnOrigin,
  refreshLanes,
  focusSpecCard,
  focusBrainCard,
  showCanvasToast,
  getCanvasDiffCards,
}: UseCanvasSpawnersDeps) {
  /** Bloom an agent card for a freshly-live lane — the spawn → card-appears
   *  moment. Deduped by laneId so a lane is only ever carded once; the card then
   *  tracks that lane's phase live from activeLanes. */
  const bloomAgentCard = useCallback((lane: LaneRow) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    // Cluster near siblings — the last card in this repo, else the last agent
    // card overall (same spawn burst). findFreeSpot returns the nearest FREE
    // cell to the anchor, so a fleet reads as a group.
    const anchor = (lane.repoPath ? agentAnchorsRef.current.byRepo.get(lane.repoPath) : null) ?? agentAnchorsRef.current.last;
    const target = findFreeSpot(AGENT_FULL_W, AGENT_FULL_H, anchor);
    agentAnchorsRef.current.last = target;
    if (lane.repoPath) agentAnchorsRef.current.byRepo.set(lane.repoPath, target);
    const choreography = reducedMotion() ? null : takeSpawnChoreography();
    const start = choreography?.origin ?? target;
    // Always reserve the target — cardRectsRef only picks up the real rect on the
    // next commit's effect, so a synchronous burst (entering the canvas over a
    // running fleet) would otherwise read a stale field and stack every card on
    // the same spot. Released once the card's rect takes over collision duty.
    const reservation = { id, x: target.x, y: target.y, w: AGENT_FULL_W, h: AGENT_FULL_H };
    spawnReservationsRef.current.push(reservation);
    setAgentCards((previous) => {
      if (previous.some((card) => card.laneId === lane.id)) {
        spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
        return previous;
      }
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      const number = agentNumberRef.current;
      agentNumberRef.current += 1;
      const repoTail = lane.repoPath?.split('/').filter(Boolean).pop() ?? null;
      const symonOrigin = Boolean(
        (lane.packetId && symonSpawnPacketIdsRef.current.has(lane.packetId))
        || symonSpawnPacketIdsRef.current.has(lane.id)
        || Date.now() < symonSpawnWindowUntilRef.current,
      );
      return [...previous, {
        id,
        x: start.x,
        y: start.y,
        z: zPeakRef.current,
        w: AGENT_FULL_W,
        h: AGENT_FULL_H,
        laneId: lane.id,
        packetId: lane.packetId ?? null,
        sessionKey: lane.sessionKey ?? null,
        repoPath: lane.repoPath ?? null,
        startedAt: lane.createdAt ?? null,
        expanded: true,
        number,
        codename: codename(lane.id),
        title: lane.label?.trim() || repoTail || lane.id,
        runtime: lane.runtime ?? null,
        ...(symonOrigin ? { symonOrigin: true } : {}),
      }];
    });
    if (choreography) {
      timersRef.current.push(setTimeout(() => {
        animate(0, 1, {
          duration: CARD_ENTRANCE.sweepMs / 1000,
          ease: [0.22, 0.61, 0.36, 1],
          onUpdate: (t) => {
            setAgentCards((cards) => cards.map((card) => (
              card.id === id ? { ...card, x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t } : card
            )));
          },
          onComplete: () => {
            spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
          },
        });
      }, choreography.delayMs));
    } else {
      // Static bloom (entry burst / single new lane): hold the reservation just
      // long enough for the next commit's cardRects effect to pick up the real
      // card rect, then release so it doesn't over-reserve the field.
      timersRef.current.push(setTimeout(() => {
        spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
      }, 400));
    }
  }, [findFreeSpot, reducedMotion, takeSpawnChoreography]);

  /** Voice/canvas "spawn N agents on <task>" — the gateless worktree spawn. Hits
   *  the governed create+dispatch seam (/api/orchestrator/spawn-prompt); the new
   *  lanes go live and bloom as cards via the watcher above. Returns an ack note
   *  on a synchronous validation failure, else null (ok). */
  const spawnAgents = useCallback((task: string, count: number, repoOverride?: string | null, origin?: string | null): string | null => {
    const repoPath = repoOverride ?? activeRepoPath;
    if (!task.trim()) return 'spawn-agents needs args.task';
    if (!repoPath) return 'no repo scoped — pick a repo first';
    const n = Math.max(1, Math.min(5, Math.floor(count) || 1));
    if (origin === 'symon') symonSpawnWindowUntilRef.current = Date.now() + 20_000;
    if (n > 1 && !reducedMotion()) {
      const spawnOrigin = viewportSpawnOrigin();
      const expiresAt = Date.now() + SPAWN_CHOREOGRAPHY_TTL_MS;
      spawnChoreographyRef.current.push(...Array.from({ length: n }, (_, index) => ({
        repoPath,
        origin: spawnOrigin,
        delayMs: index * CARD_ENTRANCE.staggerMs,
        expiresAt,
      })));
    }
    spawnCanvasAgents({ repoPath, task: task.trim(), count: n, origin })
      .then((ids) => {
        if (origin === 'symon') {
          for (const id of ids) {
            symonSpawnPacketIdsRef.current.add(id);
          }
        }
        // The lane-lifecycle push usually beats these, but a couple of nudges
        // catch the lanes as the worktrees + sessions come up (~1–3s).
        refreshLanes();
        timersRef.current.push(setTimeout(refreshLanes, 1200));
        timersRef.current.push(setTimeout(refreshLanes, 3000));
      })
      .catch(() => {
        if (origin === 'symon') symonSpawnWindowUntilRef.current = 0;
      });
    return null;
  }, [activeRepoPath, reducedMotion, refreshLanes, viewportSpawnOrigin]);

  /** A lane's review diff lands as a glass card — the governance moat
   *  as a canvas object. */
  const spawnDiffCard = useCallback((lane: LaneRow, at?: SnapGeometry) => {
    return fetch(`/api/lanes/${encodeURIComponent(lane.id)}/diff?maxBytes=131072`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; packetId?: string | null; branch?: string | null; stat?: string; diff?: string; truncated?: boolean } | null) => {
        if (!data?.ok) return;
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        setDiffCards((previous) => spawnCanvasCard(previous, {
          id,
          x: spot.x,
          y: spot.y,
          z: zPeakRef.current,
          w: at?.w ?? 560,
          h: at?.h ?? 320,
          laneId: lane.id,
          packetId: data.packetId ?? null,
          title: lane.label?.trim() || lane.id,
          branch: data.branch ?? null,
          stat: data.stat ?? '',
          diff: data.diff ?? '',
          truncated: Boolean(data.truncated),
        }));
      })
      .catch(() => {});
  }, [findFreeSpot]);

  /** Active-repo working-tree diff; the worktree: prefix also drives restore. */
  const spawnWorktreeDiffCard = useCallback((at?: SnapGeometry, repoOverride?: string) => {
    const repoPath = repoOverride ?? activeRepoPath;
    if (!repoPath) return Promise.resolve();
    return fetchWorktreeDiff(repoPath)
      .then((data) => {
        if (!data) return;
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        setDiffCards((previous) => {
          // One working-tree card per repo — auto-show + the picker row both
          // route here, so a re-trigger must never stack a duplicate.
          if (previous.some((card) => card.laneId === `worktree:${repoPath}`)) return previous;
          return [...previous, worktreeDiffCardFromData({ id, z: zPeakRef.current, spot, saved: at, repoPath, data })];
        });
      })
      .catch(() => {});
  }, [activeRepoPath, findFreeSpot]);

  const refreshWorktreeDiffCard = useCallback((cardId: number): Promise<void> => {
    const repoPath = worktreeRepoPath(getCanvasDiffCards().find((card) => card.id === cardId)?.laneId ?? '');
    if (!repoPath) return Promise.resolve();
    return fetchWorktreeDiff(repoPath).then((data) => {
      if (!data) return;
      setDiffCards((previous) => previous.map((card) => (
        card.id === cardId && worktreeRepoPath(card.laneId) === repoPath
          ? { ...card, stat: data.stat, diff: data.diff, truncated: data.truncated }
          : card
      )));
    }).catch(() => {});
  }, []);

  /** The active review's PR diff as a glass card — what the Alerts
   *  "Review ready · PR #N" row resolves to. Distinct from the working-tree
   *  card: this is the review branch vs its base (the PR itself), NOT your
   *  uncommitted edits in whatever repo the canvas happens to point at —
   *  that mismatch was the bug this replaced. laneId carries a review:
   *  prefix so the restore path and dedupe both recognise it. */
  const spawnReviewDiffCard = useCallback((at?: SnapGeometry) => {
    // No workspace param — match the inbox alert, which is built from the
    // GLOBAL review snapshot (not the canvas's active repo). Passing the active
    // repo here would re-introduce the very mismatch this card fixes.
    return fetch('/api/review/diff')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; branch?: string | null; stat?: string; diff?: string; truncated?: boolean; prNumber?: number | null; prTitle?: string | null } | null) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        const pr = data?.ok ? data.prNumber ?? null : null;
        const title = pr
          ? `PR #${pr}${data?.prTitle ? ` · ${data.prTitle}` : ''}`
          : data?.ok
            ? `Review · ${data.branch ?? 'changes'}`
            : 'Review';
        const body = data?.ok
          ? (data.diff?.trim() ? data.diff : 'No diff is available for this review yet.')
          : 'No active review workspace is configured.';
        setDiffCards((previous) => {
          // One review card at a time — the PR alert always resolves here.
          if (previous.some((card) => card.laneId.startsWith('review:'))) return previous;
          return [...previous, {
            id,
            x: spot.x,
            y: spot.y,
            z: zPeakRef.current,
            w: at?.w ?? 560,
            h: at?.h ?? 320,
            laneId: `review:${pr ?? data?.branch ?? 'active'}`,
            packetId: null,
            title,
            branch: data?.ok ? data.branch ?? null : null,
            stat: data?.ok ? data.stat ?? '' : '',
            diff: body,
            truncated: Boolean(data?.ok && data.truncated),
          }];
        });
      })
      .catch(() => {});
  }, [findFreeSpot]);

  /** The operator's o8.md notes — the REAL spec pane in a glass card.
   *  One card per repo: a second click focuses the open one instead of
   *  spawning a duplicate editor against the same file. */
  const spawnSpecCard = useCallback(() => {
    const repoPath = activeRepoPath ?? null;
    const open = specCards.find((card) => card.repoPath === repoPath);
    if (open) {
      focusSpecCard(open.id);
      return;
    }
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(760, 540);
    setSpecCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 760,
      h: 540,
      repoPath,
    }]);
  }, [activeRepoPath, findFreeSpot, focusSpecCard, specCards]);

  /** The Engineering Brain as a card — one per repo, like the o8.md card;
   *  a second click focuses the open one. An intent-bus question rides in as
   *  a one-shot `initialQuestion` the card asks itself. */
  const spawnBrainCard = useCallback((question?: string) => {
    const repoPath = activeRepoPath ?? null;
    const open = brainCards.find((card) => card.repoPath === repoPath);
    if (open) {
      focusBrainCard(open.id);
      if (question?.trim()) {
        setBrainCards((previous) => previous.map((card) => (
          card.id === open.id ? { ...card, initialQuestion: question.trim() } : card
        )));
      }
      return;
    }
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(360, 460);
    setBrainCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 360,
      h: 380,
      repoPath,
      ...(question?.trim() ? { initialQuestion: question.trim() } : {}),
    }]);
  }, [activeRepoPath, brainCards, findFreeSpot, focusBrainCard]);

  /** Render-on-screen (#1270) — bloom a markdown explainer the orchestrator
   *  authored. Each call is a fresh card (you can show several), sized for a
   *  comfortable read; the content is static + ephemeral. */
  const spawnMarkdownCard = useCallback((title: string, markdown: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(380, 460);
    setMarkdownCards((previous) => spawnCanvasCard(previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 380,
      h: 360,
      title: title.trim() || 'Note',
      markdown,
    }));
  }, [findFreeSpot]);

  /** A REAL browser pane — defaults to the app's own dashboard. */
  const spawnBrowserCard = useCallback(() => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(640, 492);
    setBrowserCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 640,
      h: 400,
      tabs: [{ id: 1, url: `${window.location.origin}/dashboard` }],
      activeTabId: 1,
    }]);
  }, [findFreeSpot]);

  const moveBrowserCard = useCallback((id: number, x: number, y: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeBrowserCard = useCallback((id: number, w: number, h: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  const changeBrowserTabs = useCallback((id: number, tabs: BrowserTab[], activeTabId: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, tabs, activeTabId } : card)));
  }, []);

  const closeBrowserCard = useCallback((id: number) => {
    setBrowserCards((previous) => previous.filter((card) => card.id !== id));
  }, []);

  /** Open ANY file on the machine as a glass card — view, edit, ⌘S. */
  const spawnFileCard = useCallback((path: string, at?: SnapGeometry, repoOverride?: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    const spot = at ?? findFreeSpot(620, 456);
    const repoPath = findFileRepoPath(path, [repoOverride, activeRepoPath, ...(repos ?? []).map((repo) => repo.path)]);
    setFileCards((previous) => spawnCanvasCard(previous, {
      id,
      path,
      name: path.split('/').pop() || path,
      repoPath,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 620,
      h: at?.h ?? 420,
      z,
    }));
  }, [activeRepoPath, findFreeSpot, repos]);

  const spawnFileTreeCard = useCallback((repoPath: string, at?: SnapGeometry) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = at ?? findFreeSpot(380, 523);
    setTreeCards((previous) => spawnCanvasCard(previous, {
      id,
      repoPath,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 380,
      h: at?.h ?? 460,
      z: zPeakRef.current,
    }));
  }, [findFreeSpot]);

  const openPathAsFileCard = useCallback((rawPath: string): boolean => {
    const path = rawPath.trim();
    if (!path) {
      showCanvasToast('Enter an absolute file path.', 'error');
      return false;
    }
    if (!path.startsWith('/')) {
      showCanvasToast('Open file needs an absolute path.', 'error');
      return false;
    }
    spawnFileCard(path);
    setFilePathPickerOpen(false);
    setFilePathInput('');
    showCanvasToast('File card opened.', 'success');
    return true;
  }, [showCanvasToast, spawnFileCard]);

  return {
    bloomAgentCard,
    spawnAgents,
    spawnDiffCard,
    spawnWorktreeDiffCard,
    refreshWorktreeDiffCard,
    spawnReviewDiffCard,
    spawnSpecCard,
    spawnBrainCard,
    spawnMarkdownCard,
    spawnBrowserCard,
    moveBrowserCard,
    resizeBrowserCard,
    changeBrowserTabs,
    closeBrowserCard,
    spawnFileCard,
    spawnFileTreeCard,
    openPathAsFileCard,
  };
}
