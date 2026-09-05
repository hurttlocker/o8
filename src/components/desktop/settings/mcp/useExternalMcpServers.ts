import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  EMPTY_EXTERNAL_SERVER_FORM,
  parseArgsInput,
  parseEnvInput,
  type ExternalMcpFormState,
  type ExternalMcpServer,
} from './shared';
import { isNpxFamily } from '@/lib/mcp/npx-detection';
import { isTauri } from '@/lib/tauri/bridge';

export interface McpServerTestOutcome {
  ok: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  durationMs?: number;
  error?: string;
  stderr?: string;
  /** True when the probe ran with the extended npx-family timeout. */
  npxFamily?: boolean;
}

export interface UseExternalMcpServersResult {
  servers: ExternalMcpServer[];
  loading: boolean;
  error: string | null;
  note: { message: string; ok: boolean } | null;
  actionId: string | null;
  creating: boolean;
  form: ExternalMcpFormState;
  setForm: Dispatch<SetStateAction<ExternalMcpFormState>>;
  create: () => Promise<void>;
  createServer: (payload: {
    name: string;
    transport: 'stdio' | 'http';
    command: string;
    args: string[];
    env: Record<string, string> | null;
  }) => Promise<boolean>;
  toggle: (server: ExternalMcpServer) => Promise<void>;
  toggleWorkerInjection: (server: ExternalMcpServer) => Promise<void>;
  toggleSymonInjection: (server: ExternalMcpServer) => Promise<void>;
  remove: (server: ExternalMcpServer) => Promise<void>;
  testingId: string | null;
  /** True when the in-flight test is for an npx-family command (extended timeout). */
  testingNpxFamily: boolean;
  testResults: Record<string, McpServerTestOutcome>;
  test: (server: ExternalMcpServer) => Promise<void>;
}

export function useExternalMcpServers(): UseExternalMcpServersResult {
  const [servers, setServers] = useState<ExternalMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ message: string; ok: boolean } | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ExternalMcpFormState>(EMPTY_EXTERNAL_SERVER_FORM);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingNpxFamily, setTestingNpxFamily] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, McpServerTestOutcome>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/mcp-servers');
      const json = await res.json().catch(() => ({})) as { servers?: ExternalMcpServer[]; error?: string };
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load external MCP servers');
      }
      setServers(Array.isArray(json.servers) ? json.servers : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load external MCP servers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Direct add from an already-parsed server (the smart paste box) — no
   *  round-trip through the manual form fields. */
  const createServer = useCallback(async (payload: {
    name: string;
    transport: 'stdio' | 'http';
    command: string;
    args: string[];
    env: Record<string, string> | null;
  }) => {
    setCreating(true);
    setNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, enabled: true }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error || 'Failed to add MCP server');
      setNote({ message: `${payload.name} added.`, ok: true });
      await load();
      return true;
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to add MCP server.', ok: false });
      return false;
    } finally {
      setCreating(false);
    }
  }, [load]);

  const create = useCallback(async () => {
    setCreating(true);
    setNote(null);
    try {
      const transport = form.transport;
      const args = transport === 'stdio' ? parseArgsInput(form.argsJson) : [];
      const env = transport === 'stdio' ? parseEnvInput(form.envJson) : null;

      const res = await fetch('/api/setup/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          transport,
          command: form.command,
          args,
          env,
          enabled: form.enabled,
        }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to add MCP server');
      }

      setForm(EMPTY_EXTERNAL_SERVER_FORM);
      setNote({ message: 'External MCP server added.', ok: true });
      await load();
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to add MCP server.', ok: false });
    } finally {
      setCreating(false);
    }
  }, [form, load]);

  const toggle = useCallback(async (server: ExternalMcpServer) => {
    setActionId(server.id);
    setNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id, enabled: !server.enabled }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to update MCP server');
      }
      setNote({
        message: `${server.name} ${server.enabled ? 'disabled' : 'enabled'} for orchestrator runs.`,
        ok: true,
      });
      await load();
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to update MCP server.', ok: false });
    } finally {
      setActionId(null);
    }
  }, [load]);

  const toggleWorkerInjection = useCallback(async (server: ExternalMcpServer) => {
    setActionId(server.id);
    setNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id, workerInjection: !server.workerInjection }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to update worker attachment');
      }
      setNote({
        message: `${server.name} ${server.workerInjection ? 'detached from' : 'attached to'} supported workers.`,
        ok: true,
      });
      await load();
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to update worker attachment.', ok: false });
    } finally {
      setActionId(null);
    }
  }, [load]);

  const toggleSymonInjection = useCallback(async (server: ExternalMcpServer) => {
    setActionId(server.id);
    setNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id, symonInjection: !server.symonInjection }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to update Symon attachment');
      }
      let refreshDeferred = false;
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('symon_mcp_refresh');
        } catch {
          refreshDeferred = true;
        }
      }
      setNote({
        message: `${server.name} ${server.symonInjection ? 'detached from' : 'attached to'} Symon.${refreshDeferred ? ' The catalog refresh will retry automatically.' : ''}`,
        ok: true,
      });
      await load();
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to update Symon attachment.', ok: false });
    } finally {
      setActionId(null);
    }
  }, [load]);

  const remove = useCallback(async (server: ExternalMcpServer) => {
    setActionId(server.id);
    setNote(null);
    try {
      const res = await fetch('/api/setup/mcp-servers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || 'Failed to remove MCP server');
      }
      setNote({ message: `${server.name} removed.`, ok: true });
      await load();
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Failed to remove MCP server.', ok: false });
    } finally {
      setActionId(null);
    }
  }, [load]);

  const test = useCallback(async (server: ExternalMcpServer) => {
    setTestingId(server.id);
    setTestingNpxFamily(server.transport === 'stdio' && isNpxFamily(server.command));
    try {
      const res = await fetch('/api/panel/mcp-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id }),
      });
      const body = await res.json().catch(() => ({})) as {
        ok?: boolean;
        toolCount?: number;
        tools?: Array<{ name: string; description?: string }>;
        durationMs?: number;
        error?: string;
        stderr?: string;
        npxFamily?: boolean;
      };
      const outcome: McpServerTestOutcome = {
        ok: Boolean(body.ok),
        toolCount: typeof body.toolCount === 'number' ? body.toolCount : undefined,
        tools: Array.isArray(body.tools) ? body.tools : undefined,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
        stderr: typeof body.stderr === 'string' ? body.stderr : undefined,
        npxFamily: body.npxFamily === true ? true : undefined,
      };
      setTestResults((current) => ({ ...current, [server.id]: outcome }));
    } catch (e) {
      setTestResults((current) => ({
        ...current,
        [server.id]: {
          ok: false,
          error: e instanceof Error ? e.message : 'Test failed',
        },
      }));
    } finally {
      setTestingId(null);
      setTestingNpxFamily(false);
    }
  }, []);

  return {
    servers,
    loading,
    error,
    note,
    actionId,
    creating,
    form,
    setForm,
    create,
    createServer,
    toggle,
    toggleWorkerInjection,
    toggleSymonInjection,
    remove,
    testingId,
    testingNpxFamily,
    testResults,
    test,
  };
}
