type InvalidationHandler = () => void;

const handlers = new Set<InvalidationHandler>();

export function registerSymonMcpCacheInvalidator(handler: InvalidationHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function invalidateSymonMcpToolCache(): void {
  for (const handler of handlers) handler();
}
