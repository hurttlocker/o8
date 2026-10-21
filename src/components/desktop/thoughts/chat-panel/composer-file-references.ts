export interface ComposerFileReferences { body: string; paths: string[] }

/** Only completed file references become tags. An unfinished @ token stays editable. */
export function readComposerFileReferences(input: string): ComposerFileReferences {
  const paths: string[] = [];
  const pattern = /(^|\s)@("[^"\r\n]+"|[^\s"@]+)(?=\s)/g;
  let body = ''; let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    const [, prefix, token] = match;
    const path = token.startsWith('"') ? token.slice(1, -1) : token;
    if (!path || path.endsWith('/') || /[\x00-\x1f<>]|^[a-z]+:\/\//i.test(path) || (!path.includes('/') && !/\.[\w-]+$/.test(path))) continue;
    if (!paths.includes(path)) paths.push(path);
    body += input.slice(cursor, match.index + prefix.length);
    cursor = match.index + match[0].length + 1;
  }
  return { body: body + input.slice(cursor), paths };
}

export function writeComposerFileReferences(body: string, paths: readonly string[]): string {
  if (!paths.length) return body;
  const refs = [...new Set(paths)].map(path => `@${/\s/.test(path) ? `"${path}"` : path}`).join(' ');
  return `${refs}\n${body}`;
}

export function addComposerFileReference(input: string, path: string, cursor: number) {
  const { body, paths } = readComposerFileReferences(input);
  const before = body.slice(0, cursor).replace(/(^|\s)@[^\s]*$/, '$1');
  const nextBody = `${before}${body.slice(cursor)}`;
  return { input: writeComposerFileReferences(nextBody, [...paths, path]), cursor: before.length };
}
