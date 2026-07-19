import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

type TextContent = { type: 'text'; text: string };
type McpToolResult = {
  content: TextContent[];
  isError?: boolean;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

type CompositeStep =
  | 'navigate_dashboard'
  | 'select_repo'
  | 'open_new_tab_menu'
  | 'pick_orchestrator'
  | 'wait_for_composer'
  | 'locate_menu_trigger'
  | 'wait_for_popover'
  | 'pick_menu_option'
  | 'verify_popover_closed'
  | 'read_surface_state';

interface CompositeError {
  ok: false;
  step: CompositeStep;
  error: string;
  state?: unknown;
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as { content?: unknown }).content);
}

function toolError(step: CompositeStep, error: unknown, state?: unknown): McpToolResult {
  const payload: CompositeError = {
    ok: false,
    step,
    error: error instanceof Error ? error.message : String(error),
    ...(state === undefined ? {} : { state }),
  };
  return jsonResult(payload, true);
}

function optionalString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function buildJsonEval(body: string): string {
  return `(() => {
  try {
${body}
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})()`;
}

async function evalJson(client: O8WebviewClient, code: string): Promise<Record<string, unknown>> {
  const raw = await client.evalJs(code);
  try {
    const parsed = JSON.parse(raw.result);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { ok: false, error: 'eval returned non-object JSON' };
  } catch {
    return { ok: false, error: `eval returned unparseable JSON: ${raw.result.slice(0, 200)}` };
  }
}

function isOk(value: Record<string, unknown>): boolean {
  return value.ok === true;
}

async function waitForState(
  client: O8WebviewClient,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    latest = await evalJson(client, SURFACE_STATE_SCRIPT);
    if (isOk(latest) && predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

async function runActionThenVerify(
  client: O8WebviewClient,
  step: CompositeStep,
  action: () => Promise<unknown>,
  verify: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | McpToolResult> {
  try {
    await action();
  } catch (error) {
    const state = await waitForState(client, verify, 1_500);
    if (verify(state)) {
      return { ok: true, warning: error instanceof Error ? error.message : String(error), state };
    }
    return toolError(step, error, state);
  }

  const state = await waitForState(client, verify, 5_000);
  if (!verify(state)) {
    return toolError(step, 'verification did not pass before timeout', state);
  }
  return state;
}

function visibleDomHelpers(): string {
  return `
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => norm(value).toLowerCase();
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.getAttribute('placeholder') || '');
    const clickElement = (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const rect = el.getBoundingClientRect();
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mouse);
      const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new PointerCtor('pointerdown', Object.assign({ buttons: 1 }, pointer)));
      el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, mouse)));
      el.dispatchEvent(new PointerCtor('pointerup', Object.assign({ buttons: 0 }, pointer)));
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, mouse)));
      el.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, mouse)));
    };
  `;
}

function buildSurfaceStateScript({ focusComposer }: { focusComposer: boolean }): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const route = window.location.pathname + window.location.search + window.location.hash;
    const active = document.activeElement;
    const composerCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(isVisible);
    const composer = composerCandidates.find((el) => el.getAttribute('data-o8-active-composer') === 'true') || composerCandidates.find((el) => {
      const label = lower(labelFor(el));
      return label.includes('message') || label.includes('ask') || label.includes('queue') || label.includes('reply') || label.includes('orchestrator');
    }) || composerCandidates[0] || null;
    const activeText = (() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
      const activeLike = buttons.find((el) => {
        const bg = window.getComputedStyle(el).backgroundColor;
        return el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') || (el.style && Number(el.style.zIndex || 0) >= 2) || (bg && bg !== 'rgba(0, 0, 0, 0)');
      });
      return activeLike ? labelFor(activeLike) : '';
    })();
    const bodyText = norm(document.body ? document.body.innerText : '');
    const activeLabel = lower(activeText);
    const composerLabel = lower(labelFor(composer));
    const activeTabKind = activeLabel.includes('terminal')
      ? 'terminal'
      : activeLabel.includes('chat')
        ? 'chat'
        : activeLabel.includes('orchestrator') || (!!composer && (composerLabel.includes('orchestrator') || bodyText.includes('Orchestrator')))
          ? 'orchestrator'
          : null;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible)
      .map((el) => labelFor(el) || norm((el.innerText || el.textContent || '').slice(0, 80)))
      .filter(Boolean);
    const activeWorkspaceRepo = (() => {
      const label = activeText || labelFor(composer);
      const match = label.match(/^([^/]+)\\s+\\/\\s+/);
      return match ? match[1].trim() : null;
    })();
    if (${focusComposer ? 'true' : 'false'} && composer && !composer.hasAttribute('disabled')) {
      try { composer.focus({ preventScroll: true }); } catch (_) {}
    }
    const activeTabId = (() => {
      const activePill = document.querySelector('[data-pill-active="true"]');
      const tabButton = activePill && activePill.querySelector('[data-tab-id], [aria-controls], button');
      return (tabButton && (tabButton.getAttribute('data-tab-id') || tabButton.getAttribute('aria-controls'))) || null;
    })();
    return JSON.stringify({
      ok: true,
      route,
      activeWorkspaceRepo,
      activeTabKind,
      activeTabId,
      openDialogs: dialogs,
      composerFocused: !!composer && document.activeElement === composer,
      composerFocusable: !!composer && !composer.hasAttribute('disabled'),
    });
  `);
}

export const SURFACE_STATE_SCRIPT = buildSurfaceStateScript({ focusComposer: false });
const FOCUS_SURFACE_STATE_SCRIPT = buildSurfaceStateScript({ focusComposer: true });

export function buildPickMenuTriggerScript(menuLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(menuLabel.toLowerCase())};
    const isMenuTrigger = (el) => {
      if (el.getAttribute('aria-pressed') !== null) return false;
      if (el.getAttribute('role') === 'tab') return false;
      if (el.getAttribute('aria-haspopup')) return true;
      const expanded = el.getAttribute('aria-expanded');
      return expanded === 'true' || expanded === 'false';
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], a[href]'))
      .filter(isVisible)
      .filter(isMenuTrigger);
    const trigger = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!trigger) return JSON.stringify({ ok: false, error: 'menu trigger not found', menuLabel: ${JSON.stringify(menuLabel)} });
    clickElement(trigger);
    return JSON.stringify({ ok: true, trigger: labelFor(trigger) });
  `);
}

export function buildPickMenuOptionScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]')).filter(isVisible);
    const option = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!option) return JSON.stringify({ ok: false, error: 'menu option not found', optionLabel: ${JSON.stringify(optionLabel)} });
    clickElement(option);
    return JSON.stringify({ ok: true, option: labelFor(option) });
  `);
}

function buildMenuOptionVisibleScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    return JSON.stringify({ ok: true, popoverVisible: candidates.length > 0 || !!option, optionVisible: !!option });
  `);
}

function buildMenuOptionClosedScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    const popovers = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    return JSON.stringify({ ok: true, closed: !option && popovers.length === 0, optionVisible: !!option, popoverCount: popovers.length });
  `);
}

function buildSelectRepoScript(repo: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(repo.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(isVisible);
    const target = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!target) return JSON.stringify({ ok: false, error: 'repo target not found', repo: ${JSON.stringify(repo)} });
    clickElement(target);
    return JSON.stringify({ ok: true, repo: labelFor(target) });
  `);
}

async function ensureDashboard(client: O8WebviewClient): Promise<Record<string, unknown> | McpToolResult> {
  return runActionThenVerify(
    client,
    'navigate_dashboard',
    () => client.navigate('/dashboard'),
    (state) => typeof state.route === 'string' && state.route.startsWith('/dashboard'),
  );
}

async function clickAndRequireOk(client: O8WebviewClient, step: CompositeStep, code: string): Promise<Record<string, unknown> | McpToolResult> {
  try {
    const result = await evalJson(client, code);
    if (!isOk(result)) {
      return toolError(step, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
    return result;
  } catch (error) {
    const state = await evalJson(client, SURFACE_STATE_SCRIPT).catch(() => undefined);
    return toolError(step, error, state);
  }
}

async function evalActionThenVerify(
  client: O8WebviewClient,
  step: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(step, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(step, warning ?? 'verification did not pass before timeout', verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function evalActionThenWaitFor(
  client: O8WebviewClient,
  actionStep: CompositeStep,
  waitStep: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(actionStep, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(waitStep, warning ?? 'verification did not pass before timeout', verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function waitForEval(
  client: O8WebviewClient,
  code: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    latest = await evalJson(client, code);
    if (isOk(latest) && predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

export const O8_WEBVIEW_COMPOSITE_TOOLS: McpTool[] = [
  {
    name: 'o8_view_new_orchestrator_session',
    description: 'USE THIS WHEN you need a fresh o8 orchestrator tab ready for input. Opens the real New tab menu, picks Orchestrator, focuses the composer, and returns structured state instead of relying on screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional repo/workspace label to select before opening the orchestrator tab. Omit or pass an empty string to use the current workspace.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_pick_menu_option',
    description: 'USE THIS WHEN you need to choose an item from an o8 popover or menu by labels. Finds the trigger by aria-label/title/visible text, clicks the option by text, and verifies the popover closed.',
    inputSchema: {
      type: 'object',
      properties: {
        menuLabel: { type: 'string', description: 'Visible text, title, or aria-label of the menu trigger.' },
        optionLabel: { type: 'string', description: 'Visible text of the menu option to choose.' },
      },
      required: ['menuLabel', 'optionLabel'],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_surface_state',
    description: 'USE THIS WHEN you need a structured read-only snapshot of the active o8 surface: route, active workspace, active tab kind, open dialogs, and composer focus state. Uses one eval batch and no screenshots.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

export function createO8WebviewCompositeHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
    o8_view_new_orchestrator_session: async (args) => {
      const client = getClient();
      const repo = optionalString(args, 'repo');

      const dashboard = await ensureDashboard(client);
      if (isMcpToolResult(dashboard)) return dashboard;

      if (repo) {
        const selected = await clickAndRequireOk(client, 'select_repo', buildSelectRepoScript(repo));
        if (isMcpToolResult(selected)) return selected;
      }

      // The spawn entry moved from a workspace "New tab" menu to the left
      // rail's "New session" row (2026-07). Try the current trigger first,
      // keep "New tab" as a fallback for older shells (#1571).
      let opened = await evalActionThenWaitFor(
        client,
        'open_new_tab_menu',
        'wait_for_popover',
        buildPickMenuTriggerScript('New session'),
        buildMenuOptionVisibleScript('Orchestrator'),
        (value) => value.optionVisible === true,
        5_000,
      );
      if (isMcpToolResult(opened)) {
        opened = await evalActionThenWaitFor(
          client,
          'open_new_tab_menu',
          'wait_for_popover',
          buildPickMenuTriggerScript('New tab'),
          buildMenuOptionVisibleScript('Orchestrator'),
          (value) => value.optionVisible === true,
          5_000,
        );
      }
      if (isMcpToolResult(opened)) return opened;

      const option = await evalActionThenVerify(
        client,
        'pick_orchestrator',
        buildPickMenuOptionScript('Orchestrator'),
        FOCUS_SURFACE_STATE_SCRIPT,
        (value) => value.composerFocusable === true && value.activeTabKind === 'orchestrator',
        7_500,
      );
      if (isMcpToolResult(option)) return option;

      const state = await waitForState(
        client,
        (current) => current.composerFocusable === true && current.activeTabKind === 'orchestrator',
        7_500,
      );
      if (state.composerFocusable !== true) {
        return toolError('wait_for_composer', 'composer was not focusable before timeout', state);
      }
      return jsonResult({ ok: true, tabId: typeof state.activeTabId === 'string' ? state.activeTabId : undefined, state });
    },

    o8_view_pick_menu_option: async (args) => {
      let menuLabel: string;
      let optionLabel: string;
      try {
        menuLabel = requiredString(args, 'menuLabel');
        optionLabel = requiredString(args, 'optionLabel');
      } catch (error) {
        return toolError('locate_menu_trigger', error);
      }

      const client = getClient();
      const trigger = await evalActionThenWaitFor(
        client,
        'locate_menu_trigger',
        'wait_for_popover',
        buildPickMenuTriggerScript(menuLabel),
        buildMenuOptionVisibleScript(optionLabel),
        (value) => value.optionVisible === true,
        5_000,
      );
      if (isMcpToolResult(trigger)) return trigger;

      const option = await evalActionThenVerify(
        client,
        'pick_menu_option',
        buildPickMenuOptionScript(optionLabel),
        buildMenuOptionClosedScript(optionLabel),
        (value) => value.closed === true,
        2_000,
      );
      if (isMcpToolResult(option)) return option;
      return jsonResult({ ok: true, menuLabel, optionLabel, state: option });
    },

    o8_view_surface_state: async () => {
      const client = getClient();
      try {
        const state = await evalJson(client, SURFACE_STATE_SCRIPT);
        if (!isOk(state)) return toolError('read_surface_state', typeof state.error === 'string' ? state.error : 'state eval failed', state);
        const publicState = { ...state };
        delete publicState.ok;
        delete publicState.composerFocusable;
        return jsonResult(publicState);
      } catch (error) {
        return toolError('read_surface_state', error);
      }
    },
  };
}
