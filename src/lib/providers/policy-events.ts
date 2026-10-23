const listeners = new Set<() => void>();
export function onCredentialPolicyChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function credentialPolicyChanged(): void { for (const listener of listeners) listener(); }
