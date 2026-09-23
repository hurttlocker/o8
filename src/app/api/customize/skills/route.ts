import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readSkillInstructions } from '@/lib/customize/read-skill';
import { parseSkillMarkdown, skillSchema } from '@/lib/customize/packages';
import { createSkill, CustomizeError, resolveScope } from '@/lib/customize/storage';
import { customizeFailure, readCustomizeBody } from '@/lib/customize/http';
export const runtime = 'nodejs';
const schema = z.object({ repo: z.string().nullable().optional(), skill: skillSchema.optional(), markdown: z.string().max(64 * 1024).optional() }).strict()
  .refine((input) => Boolean(input.skill) !== (input.markdown !== undefined));
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const input = schema.parse(await readCustomizeBody(request));
    const repo = await resolveScope(input.repo);
    let skill = input.skill;
    if (!skill) {
      try { skill = parseSkillMarkdown(input.markdown!); } catch (error) { throw new CustomizeError('invalid_skill', (error as Error).message); }
    }
    return NextResponse.json({ ok: true, file: createSkill(repo, skill) }, { status: 201 });
  } catch (error) { return customizeFailure(error); }
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const repo = await resolveScope(request.nextUrl.searchParams.get('repo'));
    const file = request.nextUrl.searchParams.get('file');
    if (!file) throw new CustomizeError('invalid_file', 'Select a skill.');
    return NextResponse.json({ ok: true, instructions: readSkillInstructions(repo, file) });
  } catch (error) { return customizeFailure(error); }
}
