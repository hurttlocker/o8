import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * GET /api/panel/session-costs?agent=Mister&since=6
 * 
 * Returns token usage + cost data for sessions from the last N hours.
 * Reads directly from JSONL transcript files.
 * 
 * Response: { sessions: [{ id, agent, cost, inputTokens, outputTokens, cacheTokens, messages }] }
 */

interface SessionCost {
  id: string;
  agent: string;
  agentKey: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  messages: number;
  model: string;
  active: boolean;
}

const AGENT_DIRS: Record<string, string> = {
  main: 'main',
  ace: 'ace',
  hawk: 'hawk',
};

const AGENT_NAMES: Record<string, string> = {
  main: 'Main Agent',
  ace: 'Agent 2',
  hawk: 'Agent 3',
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const agentFilter = url.searchParams.get('agent'); // optional: filter by agent name
    const sinceHours = parseInt(url.searchParams.get('since') || '20', 10);
    const sinceTs = Date.now() - sinceHours * 60 * 60 * 1000;

    const sessionsRoot = join(homedir(), '.openclaw', 'agents');
    const results: SessionCost[] = [];

    for (const [agentId, dirName] of Object.entries(AGENT_DIRS)) {
      const agentName = AGENT_NAMES[agentId] || agentId;
      if (agentFilter) {
        const filterLower = agentFilter.toLowerCase();
        if (filterLower !== agentName.toLowerCase() && filterLower !== agentId.toLowerCase()) continue;
      }

      const sessionsDir = join(sessionsRoot, dirName, 'sessions');
      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const stat = statSync(filePath);
          // Skip files not modified since cutoff
          if (stat.mtimeMs < sinceTs) continue;

          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(Boolean);

          let cost = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          let cacheTokens = 0;
          let messages = 0;
          let model = '';
          let hasActivity = false;

          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
              if (ts < sinceTs) continue;
              hasActivity = true;

              const msg = d.message || {};
              const usage = msg.usage || {};
              const costData = usage.cost || {};

              if (costData.total) {
                cost += costData.total;
                inputTokens += usage.input || 0;
                outputTokens += usage.output || 0;
                cacheTokens += usage.cacheRead || 0;
                messages += 1;
              }

              // Capture model from api field
              if (msg.api && !model) {
                model = msg.model || msg.api || '';
              }
            } catch { /* skip malformed lines */ }
          }

          if (!hasActivity) continue;

          // Active = modified in last 5 minutes
          const isActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;

          results.push({
            id: basename(file, '.jsonl'),
            agent: agentName,
            agentKey: `agent:${agentId}:main`,
            cost,
            inputTokens,
            outputTokens,
            cacheTokens,
            messages,
            model,
            active: isActive,
          });
        } catch { /* skip unreadable files */ }
      }
    }

    // Sort by cost descending
    results.sort((a, b) => b.cost - a.cost);

    // Aggregate totals
    const totals = {
      cost: results.reduce((s, r) => s + r.cost, 0),
      inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
      cacheTokens: results.reduce((s, r) => s + r.cacheTokens, 0),
      messages: results.reduce((s, r) => s + r.messages, 0),
      sessions: results.length,
    };

    // Per-agent totals
    const byAgent: Record<string, { cost: number; tokens: number; sessions: number }> = {};
    for (const r of results) {
      if (!byAgent[r.agent]) byAgent[r.agent] = { cost: 0, tokens: 0, sessions: 0 };
      byAgent[r.agent].cost += r.cost;
      byAgent[r.agent].tokens += r.inputTokens + r.outputTokens + r.cacheTokens;
      byAgent[r.agent].sessions += 1;
    }

    return NextResponse.json({ sessions: results, totals, byAgent });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
