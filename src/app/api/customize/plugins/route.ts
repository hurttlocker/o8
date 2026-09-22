import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePanelAuth } from '@/lib/panel/auth';
import { packageSchema, PROJECT_GUIDE } from '@/lib/customize/packages';
import { changePackage, installPackage, inspectPackages, resolveScope } from '@/lib/customize/storage';
import { customizeFailure, readCustomizeBody } from '@/lib/customize/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const scope = z.string().nullable().optional();
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('install'), repo: scope, manifest: packageSchema, expectedRevision: z.string().nullable() }).strict(),
  z.object({ action: z.enum(['enable', 'disable', 'remove']), repo: scope, id: z.string(), revision: z.string() }).strict(),
]);
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const repo = await resolveScope(request.nextUrl.searchParams.get('repo'));
    return NextResponse.json({ ok: true, catalog: [PROJECT_GUIDE], ...inspectPackages(repo) });
  } catch (error) { return customizeFailure(error); }
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const input = schema.parse(await readCustomizeBody(request));
    const repo = await resolveScope(input.repo);
    if (input.action === 'install') return NextResponse.json({ ok: true, installed: installPackage(repo, input.manifest, input.expectedRevision) });
    const result = changePackage(repo, input.id, input.revision, input.action === 'remove' ? null : input.action === 'enable');
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return customizeFailure(error); }
}
