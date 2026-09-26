// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chooseOnboardingProject } from './onboarding-projects';

const prompt = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/ConfirmToastHost', () => ({ requestPrompt: prompt }));
const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  prompt.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
});
afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

it('registers the directory returned by the actual dialog JavaScript IPC entry point', async () => {
  invoke.mockResolvedValue('/work/sample');
  const repo = { id: 'sample', name: 'Sample', localPath: '/work/sample' };
  const request = vi.fn().mockResolvedValue(Response.json({ repo }));
  await expect(chooseOnboardingProject(request)).resolves.toEqual(repo);
  expect(invoke).toHaveBeenCalledWith('plugin:dialog|open', { options: { directory: true, title: 'Select project folder' } }, undefined);
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ action: 'add', localPath: '/work/sample' });
  expect(prompt).not.toHaveBeenCalled();
});

it('treats cancel as completion without showing fallback or registering a project', async () => {
  invoke.mockResolvedValue(null);
  const request = vi.fn();
  await expect(chooseOnboardingProject(request)).resolves.toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

it('offers direct path entry immediately if native IPC is unavailable', async () => {
  invoke.mockRejectedValue(new Error('dialog unavailable'));
  prompt.mockResolvedValue(null);
  const request = vi.fn();
  await expect(chooseOnboardingProject(request)).resolves.toBeNull();
  expect(prompt).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});

it('registers the native plugin and grants only open on the main window', () => {
  const source = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8');
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  expect(source.includes('.plugin(tauri_plugin_dialog::init())')).toBe(true);
  expect(manifest).toMatch(/^tauri-plugin-dialog\s*=/m);
  expect(capability.windows).toEqual(['main']);
  expect(capability.permissions.filter((permission: unknown) => typeof permission === 'string' && permission.startsWith('dialog:'))).toEqual(['dialog:allow-open']);
  for (const file of ['overlay-windows', 'voice-settings', 'dictation']) {
    const other = JSON.parse(readFileSync(`src-tauri/capabilities/${file}.json`, 'utf8'));
    expect(other.permissions.some((permission: unknown) => typeof permission === 'string' && permission.startsWith('dialog:'))).toBe(false);
  }
});
