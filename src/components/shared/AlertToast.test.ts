// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertToast } from './AlertToast';
import type { Alert } from '@/lib/alerts/types';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    type: 'approval',
    severity: 'urgent',
    agentId: 'agent-1',
    agentName: 'Agent One',
    title: 'Approval needed',
    detail: 'Review the pending change',
    timestamp: 1_700_000_000_000,
    read: false,
    dismissed: false,
    actionable: true,
    actionLabel: 'Review',
    ...overrides,
  };
}

function actionButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button:not([aria-label="Dismiss"])');
}

function dismissButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Dismiss"]');
}

describe('AlertToast keyboard-reachable action', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders nothing when there are no urgent unread alerts', () => {
    act(() => root.render(createElement(AlertToast, {
      alerts: [
        makeAlert({ id: 'read', read: true }),
        makeAlert({ id: 'warn', severity: 'warning', title: 'Warn' }),
      ],
    })));
    expect(container.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('exposes the primary action as a focusable native button sibling of dismiss', () => {
    act(() => root.render(createElement(AlertToast, {
      alerts: [makeAlert()],
    })));

    const action = actionButton(container);
    const dismiss = dismissButton(container);
    expect(action).not.toBeNull();
    expect(dismiss).not.toBeNull();
    expect(action!.type).toBe('button');
    expect(action!.getAttribute('aria-label')).toBe('Review: Approval needed');
    expect(dismiss!.type).toBe('button');
    // No nested buttons — action and dismiss are siblings.
    expect(action!.contains(dismiss)).toBe(false);
    expect(dismiss!.contains(action)).toBe(false);
    expect(action!.tabIndex).toBeGreaterThanOrEqual(0);
    action!.focus();
    expect(document.activeElement).toBe(action);
    expect(container.textContent).toContain('Approval needed');
    expect(container.textContent).toContain('Review the pending change');
  });

  it('binds the action name and description to the alert content', () => {
    act(() => root.render(createElement(AlertToast, {
      alerts: [
        makeAlert({
          id: 'with-label',
          title: 'Agent One needs approval',
          detail: 'Review the pending change',
          actionLabel: 'Review',
        }),
        makeAlert({
          id: 'without-label',
          title: 'Connection failed',
          detail: 'The runtime is offline',
          actionLabel: undefined,
        }),
      ],
    })));

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button:not([aria-label="Dismiss"])'),
    );
    expect(buttons).toHaveLength(2);

    const labeled = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Review: Agent One needs approval',
    );
    const unlabeled = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Connection failed',
    );
    expect(labeled).toBeDefined();
    expect(unlabeled).toBeDefined();

    for (const button of buttons) {
      const detailId = button.getAttribute('aria-describedby');
      expect(detailId).toBeTruthy();
      const detail = container.querySelector<HTMLElement>(`[id="${detailId}"]`);
      expect(detail).not.toBeNull();
      expect(detail!.textContent).not.toBe('');
    }

    const labeledDetail = labeled!.getAttribute('aria-describedby');
    const unlabeledDetail = unlabeled!.getAttribute('aria-describedby');
    expect(container.querySelector(`[id="${labeledDetail}"]`)!.textContent)
      .toBe('Review the pending change');
    expect(container.querySelector(`[id="${unlabeledDetail}"]`)!.textContent)
      .toBe('The runtime is offline');
  });
  it('fires onAction once from the action control', () => {
    const onAction = vi.fn();
    const alert = makeAlert();

    act(() => root.render(createElement(AlertToast, {
      alerts: [alert],
      onAction,
    })));

    const action = actionButton(container)!;
    act(() => action.click());
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(alert);

    // While exiting, a second activation must not re-fire.
    act(() => action.click());
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('lets dismiss fire independently without invoking onAction', () => {
    const onAction = vi.fn();

    act(() => root.render(createElement(AlertToast, {
      alerts: [makeAlert()],
      onAction,
    })));

    const dismiss = dismissButton(container)!;
    act(() => dismiss.click());
    expect(onAction).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(actionButton(container)).toBeNull();
    expect(dismissButton(container)).toBeNull();
  });
});
