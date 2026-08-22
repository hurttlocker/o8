import { createAgentMessagePostHandler } from '@/lib/agents/message-route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createAgentMessagePostHandler();
