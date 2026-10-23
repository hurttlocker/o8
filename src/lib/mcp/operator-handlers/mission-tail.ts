import { apiFetch, errorText, jsonResult, requiredString, textResult, type McpToolResult } from './shared';

export async function handleMissionTail(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const sinceRaw = args.since;
    const since = typeof sinceRaw === 'number' && Number.isFinite(sinceRaw) && sinceRaw >= 0
      ? Math.floor(sinceRaw)
      : 0;
    const timeoutRaw = args.timeoutMs;
    const timeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(25_000, Math.floor(timeoutRaw))
      : 0;

    const qs = new URLSearchParams();
    qs.set('since', String(since));
    if (timeoutMs > 0) {
      qs.set('follow', 'true');
      qs.set('timeoutMs', String(timeoutMs));
    }

    const data = await apiFetch(`/api/lanes/${encodeURIComponent(packetId)}/events?${qs.toString()}`, {
      timeoutMs: Math.max(15_000, timeoutMs + 5_000),
    }) as Record<string, unknown>;
    const events = Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : [];
    const nextSinceRaw = data.nextSince;
    const nextSince = typeof nextSinceRaw === 'number' && Number.isFinite(nextSinceRaw)
      ? nextSinceRaw
      : since;
    return jsonResult({
      summary: events.length === 0
        ? `No packet events (nextSince: ${nextSince})`
        : `${events.length} packet events (nextSince: ${nextSince})`,
      data: {
        packetId,
        events,
        nextSince,
      },
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} mission_tail failed: ${errorText(error)}`);
    return textResult(`Failed to read mission tail: ${errorText(error)}`, true);
  }
}
