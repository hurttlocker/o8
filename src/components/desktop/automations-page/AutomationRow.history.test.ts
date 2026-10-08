// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationListRow } from './AutomationRow';
import type { AutomationRecord } from './types';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(overrides: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: 'automation-1',
    name: 'Nightly triage',
    owner: 'local',
    projectId: null,
    repoPath: '/repos/o8',
    branch: 'main',
    runtime: 'claude',
    prompt: 'Triage open issues',
    triggerKind: 'manual',
    cronExpr: null,
    enabled: true,
    nextRunAt: null,
    catchUpPolicy: 'latest',
    repoConcurrencyLimit: 1,
    precheckCommand: null,
    precheckTimeoutMs: 30_000,
    watchSourceKind: null,
    watchSourceId: null,
    watchEventTypes: [],
    watchLiteralFilter: null,
    watchQuietMs: null,
    watchMinIntervalMs: 0,
    watchBatchWindowMs: 0,
    watchMaxFiresPerTick: 1,
    watchExpiresAt: null,
    watchActionKind: 'dispatch',
    watchTargetLaneId: null,
    watchCheckpoint: 0,
    watchLastFireAt: null,
    watchState: null,
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastLaneId: null,
    lastErrorMessage: null,
    fires: [],
    fireMetrics: {
      count: 0,
      scheduleDelayMs: { p50: null, p95: null },
      queueDelayMs: { p50: null, p95: null },
      executionMs: { p50: null, p95: null },
      maxConcurrentFires: 0,
      duplicateFireCount: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHandlers() {
  return {
    onToggle: vi.fn(async () => {}),
    onEdit: vi.fn(),
    onRun: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onOpenLane: vi.fn(),
  };
}

function historyButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((button) =>
    (button.textContent ?? '').startsWith('history'),
  );
}

describe('AutomationListRow history panel controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('gives two rows distinct history panel ids with matching aria-controls when expanded', () => {
    act(() => root.render(createElement(
      'div',
      null,
      createElement(AutomationListRow, { row: makeRow({ id: 'automation-a', name: 'Alpha' }), ...makeHandlers() }),
      createElement(AutomationListRow, { row: makeRow({ id: 'automation-b', name: 'Beta' }), ...makeHandlers() }),
    )));

    const buttons = historyButtons(container);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.hasAttribute('aria-controls')).toBe(false);
    }

    act(() => {
      buttons[0].click();
      buttons[1].click();
    });

    const ids = buttons.map((button) => button.getAttribute('aria-controls'));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    for (const [index, button] of buttons.entries()) {
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const panel = document.getElementById(ids[index]!);
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain('No fires recorded yet.');
    }
  });

  it('removes the panel and aria-controls on collapse without calling row handlers', () => {
    const handlers = makeHandlers();
    act(() => root.render(createElement(AutomationListRow, { row: makeRow(), ...handlers })));

    const button = historyButtons(container)[0];
    act(() => button.click());

    const panelId = button.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(panelId!)).toBeNull();

    expect(handlers.onToggle).not.toHaveBeenCalled();
    expect(handlers.onRun).not.toHaveBeenCalled();
    expect(handlers.onEdit).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(handlers.onOpenLane).not.toHaveBeenCalled();
  });
});
