// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(async () => false),
}));

vi.mock('./useExternalMcpServers', () => ({
  useExternalMcpServers: () => ({
    servers: [{
      id: 'saved',
      name: 'saved-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      argsJson: '["server.js"]',
      envJson: null,
      enabled: true,
      workerInjection: false,
      symonInjection: false,
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    }],
    loading: false,
    error: null,
    note: null,
    actionId: null,
    creating: false,
    form: {
      name: '',
      transport: 'stdio',
      command: '',
      argsJson: '[]',
      envJson: '{}',
      enabled: true,
    },
    setForm: vi.fn(),
    create: vi.fn(),
    createServer: createServerMock,
    toggleWorkerInjection: vi.fn(),
    toggleSymonInjection: vi.fn(),
    remove: vi.fn(),
    testingId: null,
    testingNpxFamily: false,
    testResults: {},
    test: vi.fn(),
  }),
}));

import { ExternalMcpServersSection } from './ExternalMcpServersSection';

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ExternalMcpServersSection setup entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    createServerMock.mockClear();
    createServerMock.mockResolvedValue(false);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ExternalMcpServersSection));
      await settle();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('makes command or URL the default and keeps failed input intact', async () => {
    expect(container.querySelector('[aria-label="Advanced MCP JSON"]')).toBeNull();
    expect(container.textContent).toContain('Advanced JSON');
    expect(container.textContent).toContain('test connection');

    const input = container.querySelector<HTMLInputElement>('[aria-label="MCP command or URL"]');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, 'npx -y @modelcontextprotocol/server-filesystem "/path with spaces"');
      await settle();
    });
    const add = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'add');
    expect(add).toBeDefined();
    await act(async () => {
      add!.click();
      await settle();
    });

    expect(createServerMock).toHaveBeenCalledWith({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path with spaces'],
      env: null,
    });
    expect(input!.value).toBe('npx -y @modelcontextprotocol/server-filesystem "/path with spaces"');

    await act(async () => {
      setInputValue(input!, 'npx package && other');
      await settle();
    });
    expect(container.textContent).toContain('Shell operators and command substitution are not supported.');
    expect(container.textContent).not.toContain('Enter one command with its arguments');
  });

  it('keeps unsupported advanced JSON visible and explains the rejected field', async () => {
    const advanced = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Advanced JSON'));
    await act(async () => {
      advanced!.click();
      await settle();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Advanced MCP JSON"]');
    const raw = '{"command":"npx","args":["pkg"],"headers":{"Authorization":"secret"}}';
    await act(async () => {
      setInputValue(textarea!, raw);
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await settle();
    });

    expect(textarea!.value).toBe(raw);
    expect(container.textContent).toContain('unsupported field: headers');
    expect(createServerMock).not.toHaveBeenCalled();
  });
});
