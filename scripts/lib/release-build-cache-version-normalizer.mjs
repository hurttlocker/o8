const RELEASE_VERSION_PLACEHOLDER = '__O8_RELEASE_VERSION__';

function stringEnd(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') cursor += 1;
    else if (text[cursor] === '"') return cursor + 1;
  }
  return null;
}

function jsonPropertyValueStart(text, objectStart, name) {
  let depth = 1;
  for (let index = objectStart + 1; index < text.length; index += 1) {
    if (text[index] === '"') {
      const end = stringEnd(text, index);
      if (end === null) return null;
      if (depth === 1 && JSON.parse(text.slice(index, end)) === name) {
        let valueStart = end;
        while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
        if (text[valueStart++] !== ':') return null;
        while (/\s/.test(text[valueStart] ?? '')) valueStart += 1;
        return valueStart;
      }
      index = end - 1;
    } else if (text[index] === '{' || text[index] === '[') depth += 1;
    else if (text[index] === '}' || text[index] === ']') {
      depth -= 1;
      if (depth === 0) return null;
    }
  }
  return null;
}

function replaceJsonStringAt(text, valueStart) {
  if (valueStart === null || text[valueStart] !== '"') return text;
  const end = stringEnd(text, valueStart);
  return end === null ? text : `${text.slice(0, valueStart)}"${RELEASE_VERSION_PLACEHOLDER}"${text.slice(end)}`;
}

function replaceRootJsonVersion(text) {
  return replaceJsonStringAt(text, jsonPropertyValueStart(text, 0, 'version'));
}

function replacePackageLockRootVersions(text) {
  const rootVersion = jsonPropertyValueStart(text, 0, 'version');
  const packagesStart = jsonPropertyValueStart(text, 0, 'packages');
  const rootPackageStart = packagesStart === null || text[packagesStart] !== '{'
    ? null
    : jsonPropertyValueStart(text, packagesStart, '');
  const packageVersion = rootPackageStart === null || text[rootPackageStart] !== '{'
    ? null
    : jsonPropertyValueStart(text, rootPackageStart, 'version');
  return [rootVersion, packageVersion]
    .filter((valueStart) => valueStart !== null)
    .sort((left, right) => right - left)
    .reduce((normalized, valueStart) => replaceJsonStringAt(normalized, valueStart), text);
}

function replaceCargoTomlRootVersion(text) {
  const packageStart = text.search(/^\[package\]\s*$/m);
  if (packageStart < 0) return text;
  const nextTable = text.slice(packageStart + 1).search(/^\[/m);
  const packageEnd = nextTable < 0 ? text.length : packageStart + 1 + nextTable;
  const packageStanza = text.slice(packageStart, packageEnd);
  if (!/^\s*name\s*=\s*"o8"\s*$/m.test(packageStanza)) return text;
  return `${text.slice(0, packageStart)}${packageStanza.replace(
    /^(\s*version\s*=\s*)"[^"]*"/m,
    `$1"${RELEASE_VERSION_PLACEHOLDER}"`,
  )}${text.slice(packageEnd)}`;
}

function replaceCargoLockRootVersion(text) {
  return text.replace(/(^|\n)(\[\[package\]\][\s\S]*?)(?=\n\[\[package\]\]|$)/g, (stanza, prefix, body) => {
    if (!/^name\s*=\s*"o8"\s*$/m.test(body)) return stanza;
    return `${prefix}${body.replace(
      /^(version\s*=\s*)"[^"]*"/m,
      `$1"${RELEASE_VERSION_PLACEHOLDER}"`,
    )}`;
  });
}

export function normalizeReleaseBuildCacheRecipeInput(path, contents) {
  const text = contents.toString('utf8');
  if (path === 'package.json' || path === 'package-lock.json') {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      return contents;
    }
    if (manifest.name !== 'o8') return contents;
    return path === 'package-lock.json' ? replacePackageLockRootVersions(text) : replaceRootJsonVersion(text);
  }
  if (path === 'src-tauri/Cargo.toml') return replaceCargoTomlRootVersion(text);
  if (path === 'src-tauri/Cargo.lock') return replaceCargoLockRootVersion(text);
  if (path === 'src-tauri/tauri.conf.json') return replaceRootJsonVersion(text);
  return contents;
}
