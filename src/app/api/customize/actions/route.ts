import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { requirePanelAuth } from '@/lib/panel/auth';
import { ActionPluginError, actionReceipts, changeActionPlugin, invokeActionPlugin, linkActionSource, listActionPlugins, reviewActionSource } from '@/lib/action-plugins/host';
import { readCustomizeBody } from '@/lib/customize/http';
import { CustomizeError } from '@/lib/customize/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), directory: z.string().min(1), repo: z.string().optional() }).strict(),
  z.object({ action: z.literal('link'), directory: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), repo: z.string().optional() }).strict(),
  z.object({ action: z.literal('invoke'), id: z.string(), actionId: z.string(), revision: z.string(), repo: z.string().optional() }).strict(),
  z.object({ action: z.enum(['enable', 'disable', 'remove']), id: z.string(), revision: z.string() }).strict(),
]);

function failure(error: unknown) {
  if (error instanceof ActionPluginError || error instanceof CustomizeError) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ ok: false, error: { code: 'invalid_input', message: 'Check the action manifest and required fields.' } }, { status: 400 });
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return NextResponse.json({ ok: false, error: { code: 'not_found', message: 'The selected local file or installation no longer exists.' } }, { status: 404 });
  return NextResponse.json({ ok: false, error: { code: 'action_error', message: 'Could not complete this local action operation.' } }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const plugin = request.nextUrl.searchParams.get('plugin');
    return NextResponse.json({ ok: true, ...listActionPlugins(), receipts: actionReceipts(plugin ?? undefined) });
  }
  catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const input = inputSchema.parse(await readCustomizeBody(request));
    if (input.action === 'review') return NextResponse.json({ ok: true, review: await reviewActionSource(input.directory, input.repo) });
    if (input.action === 'link') return NextResponse.json({ ok: true, installed: await linkActionSource(input.directory, input.expectedRevision, input.repo) });
    if (input.action === 'invoke') return NextResponse.json({ ok: true, receipt: await invokeActionPlugin(input.id, input.actionId, 'local-operator', request.signal, input.revision, input.repo) });
    return NextResponse.json({ ok: true, ...changeActionPlugin(input.id, input.revision, input.action) });
  } catch (error) { return failure(error); }
}
