import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  EMPTY_EXTERNAL_SERVER_FORM,
  parseArgsInput,
  parseEnvInput,
  type ExternalMcpFormState,
  type ExternalMcpServer,
} from './shared';

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
  toggle: (server: ExternalMcpServer) => Promise<void>;
  remove: (server: ExternalMcpServer) => Promise<void>;
}

export function useExternalMcpServers(): UseExternalMcpServersResult {
  const [servers, setServers] = useState<ExternalMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ message: string; ok: boolean } | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ExternalMcpFormState>(EMPTY_EXTERNAL_SERVER_FORM);

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

  const remove = useCallback(async (server: ExternalMcpServer) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove external MCP server "${server.name}"?`)) {
      return;
    }
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

  return { servers, loading, error, note, actionId, creating, form, setForm, create, toggle, remove };
}
