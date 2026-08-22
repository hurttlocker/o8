import path from 'node:path';

export interface HdiSystemEntity {
  deviceEntry: string;
  mountPath: string | null;
  contentHint: string | null;
}

export function normalizedNamespacePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.startsWith('/private/var/') || resolved.startsWith('/private/tmp/')
    ? resolved.slice('/private'.length)
    : resolved;
}

export function exactDependencyImageRoot(
  systemEntities: HdiSystemEntity[],
): HdiSystemEntity {
  const roots = systemEntities.filter((entity) => (
    entity.contentHint === 'GUID_partition_scheme'
  ));
  if (roots.length !== 1) {
    throw new Error(`Disk image record returned ${roots.length} partition roots; exactly one is required.`);
  }
  return roots[0]!;
}
