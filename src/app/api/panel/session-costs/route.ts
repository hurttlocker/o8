import { and, desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { usageLogs } from '@/lib/db/schema';

type SessionSummary = {
  id: string;
  agentName: string;
  model: string;
  messages: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  active: boolean;
  createdAt: string;
};

type BreakdownSummary = {
  cost: number;
  messages: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
};

function createBreakdown(): BreakdownSummary {
  return {
    cost: 0,
    messages: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
  };
}

/**
 * GET /api/panel/session-costs?agent=Claude%20Code
 *
 * Reads persisted runtime-session cost rows from usage_logs.
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({
      sessions: [],
      totals: createBreakdown(),
      byAgent: {},
    });
  }

  const agent = request.nextUrl.searchParams.get('agent')?.trim();
  const predicate = agent
    ? and(
        eq(usageLogs.requestType, 'completion'),
        eq(usageLogs.agentName, agent),
      )
    : eq(usageLogs.requestType, 'completion');

  const rows = db
    .select()
    .from(usageLogs)
    .where(predicate)
    .orderBy(desc(usageLogs.createdAt))
    .all();

  const totals = createBreakdown();
  const byAgent = new Map<string, BreakdownSummary>();
  const sessions = new Map<string, SessionSummary>();

  for (const row of rows) {
    const sessionKey = row.sessionKey?.trim();
    if (!sessionKey) {
      continue;
    }

    const cost = row.costUsd ?? 0;
    const inputTokens = row.inputTokens ?? 0;
    const outputTokens = row.outputTokens ?? 0;
    const cacheTokens = (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    const agentName = row.agentName?.trim() || 'Runtime Session';

    totals.cost += cost;
    totals.messages += 1;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheTokens += cacheTokens;

    if (!byAgent.has(agentName)) {
      byAgent.set(agentName, createBreakdown());
    }
    const agentSummary = byAgent.get(agentName)!;
    agentSummary.cost += cost;
    agentSummary.messages += 1;
    agentSummary.inputTokens += inputTokens;
    agentSummary.outputTokens += outputTokens;
    agentSummary.cacheTokens += cacheTokens;

    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        id: sessionKey,
        agentName,
        model: row.model,
        messages: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        active: false,
        createdAt: row.createdAt,
      });
    }

    const session = sessions.get(sessionKey)!;
    session.agentName = session.agentName || agentName;
    session.model = session.model || row.model;
    session.messages += 1;
    session.cost += cost;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.cacheTokens += cacheTokens;
  }

  totals.sessions = sessions.size;

  for (const session of sessions.values()) {
    const agentSummary = byAgent.get(session.agentName);
    if (agentSummary) {
      agentSummary.sessions += 1;
    }
  }

  return NextResponse.json({
    sessions: Array.from(sessions.values())
      .map((session) => ({
        id: session.id,
        model: session.model,
        messages: session.messages,
        cost: session.cost,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cacheTokens: session.cacheTokens,
        active: session.active,
        createdAt: session.createdAt,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    totals,
    byAgent: Object.fromEntries(byAgent.entries()),
  });
}
