function verifyIdentityResponse(json, expectedBootId) {
  if (!json || typeof json !== 'object') return false;
  if (json.product !== 'o8') return false;
  if (typeof json.bootId !== 'string' || json.bootId.length === 0) return false;
  if (expectedBootId && json.bootId !== expectedBootId) return false;
  return true;
}

export { verifyIdentityResponse };
