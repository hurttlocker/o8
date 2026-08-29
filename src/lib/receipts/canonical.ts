/**
 * Return compact JSON with object keys sorted recursively.
 *
 * Arrays keep their original order. JSON's ordinary handling of unsupported
 * object values (omit) and array values (null) is preserved by normalizing the
 * value before serialization.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) {
    throw new TypeError('Canonical JSON requires a JSON-serializable root value.');
  }
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJsonValue(record[key])]),
  );
}
