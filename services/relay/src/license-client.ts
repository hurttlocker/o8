export interface LicenseServerClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface MachineHeartbeatResult {
  ok: boolean;
  status: number;
}

function bearer(token: string): { authorization: string; accept: string } {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
}

export function createLicenseServerClient(options: LicenseServerClientOptions): {
  authorizeWebMachine(token: string, machineId: string): Promise<boolean>;
  heartbeatMachine(input: {
    machineId: string;
    ticket: string;
  }): Promise<MachineHeartbeatResult>;
} {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    authorizeWebMachine: async (token, machineId) => {
      if (!token) return false;
      try {
        const response = await fetchImpl(`${baseUrl}/machines`, {
          method: 'GET',
          headers: bearer(token),
        });
        if (!response.ok) return false;
        const body = await response.json() as unknown;
        return Array.isArray(body) && body.some((candidate) => (
          typeof candidate === 'object'
          && candidate !== null
          && (candidate as { machineId?: unknown }).machineId === machineId
        ));
      } catch {
        return false;
      }
    },
    heartbeatMachine: async ({ machineId, ticket }) => {
      try {
        const response = await fetchImpl(
          `${baseUrl}/machines/${encodeURIComponent(machineId)}/heartbeat`,
          {
            method: 'POST',
            headers: bearer(ticket),
          },
        );
        return { ok: response.status === 204, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}
