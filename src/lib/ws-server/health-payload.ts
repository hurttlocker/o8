import type { InstanceIdentity } from '@/lib/panel/instance-identity';

export function buildWsHealthPayload(
  identity: Pick<InstanceIdentity, 'product' | 'instanceId' | 'bootId'>,
  options: { clients: number; eventLoop: unknown },
) {
  return {
    product: identity.product,
    instanceId: identity.instanceId,
    bootId: identity.bootId,
    status: 'ok',
    clients: options.clients,
    gateway: 'disabled',
    eventLoop: options.eventLoop,
  };
}
