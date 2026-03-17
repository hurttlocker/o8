import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * GET /api/panel/analytics?hours=24
 *
 * Returns comprehensive cost/usage analytics:
 * - totals, byAgent, byModel, hourlyBreakdown, topSessions
 */

const AGENT_DIRS: Record<string, string> = { main: 'Mister', ace: 'Niot', hawk: 'Hawk' };

interface HourBucket { hour: string; cost: number; messages: number; tokens: number }
interface ModelBreakdown { model: string; cost: number; messages: number; sessions: number }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    const sinceTs = Date.now() - hours * 60 * 60 * 1000;

    const sessionsRoot = join(homedir(), '.openclaw', 'agents');

    // Accumulators
    const hourlyMap = new Map<string, HourBucket>();
    const modelMap = new Map<string, ModelBreakdown>();
    const agentMap = new Map<string, { cost: number; messages: number; tokens: number; sessions: number }>();
    const topSessions: { id: string; agent: string; cost: number; messages: number; model: string; active: boolean }[] = [];
    let totalCost = 0, totalMessages = 0, totalInput = 0, totalOutput = 0, totalCache = 0;

    for (const [agentId, agentName] of Object.entries(AGENT_DIRS)) {
      const sessionsDir = join(sessionsRoot, agentId, 'sessions');
      let files: string[];
      try { files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < sinceTs) continue;

          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(Boolean);

          let sCost = 0, sMsgs = 0, sModel = '', hasActivity = false;

          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
              if (ts < sinceTs) continue;
              const msg = d.message || {};
              const usage = msg.usage || {};
              const costData = usage.cost || {};
              if (!costData.total) continue;
              hasActivity = true;

              const cost = costData.total;
              const input = usage.input || 0;
              const output = usage.output || 0;
              const cache = usage.cacheRead || 0;
              const model = msg.model || msg.api || 'unknown';

              sCost += cost;
              sMsgs += 1;
              totalCost += cost;
              totalMessages += 1;
              totalInput += input;
              totalOutput += output;
              totalCache += cache;
              if (!sModel && model !== 'unknown') sModel = model;

              // Hourly bucket
              const date = new Date(ts);
              const hourKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
              if (!hourlyMap.has(hourKey)) hourlyMap.set(hourKey, { hour: hourKey, cost: 0, messages: 0, tokens: 0 });
              const bucket = hourlyMap.get(hourKey)!;
              bucket.cost += cost;
              bucket.messages += 1;
              bucket.tokens += input + output + cache;

              // Model breakdown
              const modelKey = model.replace(/-\d{8}$/, ''); // strip date suffix
              if (!modelMap.has(modelKey)) modelMap.set(modelKey, { model: modelKey, cost: 0, messages: 0, sessions: 0 });
              const mb = modelMap.get(modelKey)!;
              mb.cost += cost;
              mb.messages += 1;

              // Agent accumulator
              if (!agentMap.has(agentName)) agentMap.set(agentName, { cost: 0, messages: 0, tokens: 0, sessions: 0 });
              const ab = agentMap.get(agentName)!;
              ab.cost += cost;
              ab.messages += 1;
              ab.tokens += input + output + cache;

            } catch { /* skip */ }
          }

          if (!hasActivity) continue;

          // Count session for model + agent
          const modelKey = sModel.replace(/-\d{8}$/, '');
          if (modelMap.has(modelKey)) modelMap.get(modelKey)!.sessions += 1;
          if (agentMap.has(agentName)) agentMap.get(agentName)!.sessions += 1;

          const isActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;
          topSessions.push({
            id: basename(file, '.jsonl'),
            agent: agentName,
            cost: sCost,
            messages: sMsgs,
            model: sModel,
            active: isActive,
          });
        } catch { /* skip */ }
      }
    }

    // Sort
    topSessions.sort((a, b) => b.cost - a.cost);
    const hourly = Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    const byModel = Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost);
    const byAgent = Object.fromEntries(agentMap.entries());

    return NextResponse.json({
      totals: {
        cost: totalCost,
        messages: totalMessages,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheTokens: totalCache,
        sessions: topSessions.length,
      },
      byAgent,
      byModel,
      hourly,
      topSessions: topSessions.slice(0, 10),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown' }, { status: 500 });
  }
}
