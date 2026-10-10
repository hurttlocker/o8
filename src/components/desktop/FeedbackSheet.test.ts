// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeedbackSettingsEntry } from './FeedbackSheet';

let root: Root;
let container: HTMLDivElement;
let enabled: boolean;
let payloads: unknown[];
let reply: () => Promise<Response>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  enabled = true;
  payloads = [];
  reply = async () => Response.json({ ok: true, reportId: 'feedback-receipt' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/telemetry/config') return Response.json({ enabled });
    if (url === '/api/feedback/report') {
      payloads.push(JSON.parse(String(init?.body)));
      return reply();
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const result = [...document.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(result, label).toBeDefined();
  return result!;
}

async function open() {
  await act(async () => root.render(createElement(FeedbackSettingsEntry)));
  button('Send Feedback…').focus();
  await act(async () => button('Send Feedback…').click());
}

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('opens from Settings, contains keyboard focus, and returns focus on Escape', async () => {
  await open();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement?.tagName).toBe('TEXTAREA');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
  expect(document.activeElement).toBe(button('Cancel'));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  expect(document.activeElement?.tagName).toBe('TEXTAREA');
  const outsideEscape = vi.fn();
  window.addEventListener('keydown', outsideEscape);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  window.removeEventListener('keydown', outsideEscape);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button('Send Feedback…'));
  expect(outsideEscape).not.toHaveBeenCalled();
});

it('submits signed-out feedback with default metadata and no ambient app context', async () => {
  await open();
  await type('textarea', 'The first step was confusing.');
  await act(async () => button('Send feedback').click());
  expect(payloads).toEqual([{ kind: 'feedback', message: 'The first step was confusing.', includeMetadata: true }]);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Feedback sent');
  expect(button('Send feedback').disabled).toBe(true);
});

it('retains the draft after failure and retries the selected email and metadata only', async () => {
  reply = async () => Response.json({ error: 'Please try again.' }, { status: 503 });
  await open();
  await type('textarea', 'Please make the next step clearer.');
  await type('input[type="email"]', 'reply@example.com');
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button('Send feedback').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Please try again.');
  expect(document.querySelector('textarea')?.value).toBe('Please make the next step clearer.');
  reply = async () => Response.json({ ok: true, reportId: 'retry-receipt' });
  await act(async () => button('Send feedback').click());
  expect(payloads).toEqual(Array(2).fill({ kind: 'feedback', message: 'Please make the next step clearer.', email: 'reply@example.com', includeMetadata: false }));
});

it('keeps the existing sharing choice and sends nothing when sharing is disabled', async () => {
  enabled = false;
  await open();
  await type('textarea', 'A useful note.');
  expect(button('Send feedback').disabled).toBe(true);
  expect(document.body.textContent).toContain('crash & error reports');
  expect(payloads).toEqual([]);
});

it('disables submission immediately and accepts only one click while waiting', async () => {
  let resolve!: (response: Response) => void;
  reply = () => new Promise<Response>((done) => { resolve = done; });
  await open();
  await type('textarea', 'A useful note.');
  await act(async () => { button('Send feedback').click(); button('Send feedback').click(); });
  expect(payloads).toHaveLength(1);
  expect(button('Sending feedback…').disabled).toBe(true);
  button('Send Feedback…').focus();
  expect(document.activeElement).toBe(button('Cancel'));
  await act(async () => resolve(Response.json({ ok: true, reportId: 'one-receipt' })));
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Feedback sent');
});
