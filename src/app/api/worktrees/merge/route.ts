export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { handlePost } from './handler';

export async function POST(req: NextRequest) {
  return handlePost(req, {});
}
