import { NextRequest, NextResponse } from 'next/server';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ denied: false, launch: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => state.denied ? NextResponse.json({}, { status: 401 }) : null }));
vi.mock('@/lib/runtimes', () => ({ getRuntime: (id: string) => id === 'fixture' ? { capabilities: { resume: true, costTelemetry: false }, launch: state.launch } : undefined }));
import { GET } from './route';
it('reads only adapter declarations and returns unknown for an unregistered runtime', async () => {
  expect(await GET(new NextRequest('http://localhost/api/runtime/capabilities?id=fixture')).json()).toEqual({ id: 'fixture', capabilities: { resume: true, costTelemetry: false } });
  expect(await GET(new NextRequest('http://localhost/api/runtime/capabilities?id=unknown')).json()).toEqual({ id: 'unknown', capabilities: null });
  expect(state.launch).not.toHaveBeenCalled(); state.denied = true;
  expect(GET(new NextRequest('http://localhost/api/runtime/capabilities?id=fixture')).status).toBe(401);
});
