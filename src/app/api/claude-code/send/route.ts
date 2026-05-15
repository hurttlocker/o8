import { handleClaudeCodeSend } from './streaming-spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handleClaudeCodeSend(req);
}
