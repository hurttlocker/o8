/** Display parsing only. Quotes and pipelines are data, never evaluated. */
function commandParts(text: string): Array<{ words: string[]; piped: boolean }> {
  const parts: Array<{ words: string[]; piped: boolean }> = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let piped = false;
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flushPart = () => { flushWord(); if (words.length) parts.push({ words, piped }); words = []; };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && quote !== "'" && i + 1 < text.length) {
      word += text[++i];
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ';' || char === '\n' || char === '|' || char === '&' && text[i + 1] === '&') {
      flushPart();
      piped = char === '|' && text[i + 1] !== '|';
      if (text[i + 1] === char) i += 1;
    } else if (/\s/.test(char)) {
      flushWord();
    } else {
      word += char;
    }
  }
  flushPart();
  return parts;
}

const basename = (word: string) => word.split('/').pop() ?? word;

export function activityCommandWords(command: string, depth = 0): string[] {
  if (depth > 6) return [];
  const parts = commandParts(command);
  // A pipe's reader does not replace its producer's action. Ignore shell
  // navigation and the benign `|| true` suffix when choosing the main verb.
  const selected = parts.filter(part => !part.piped && !/^(cd|true|false|echo|printf)$/.test(part.words[0] ?? '')).at(-1)
    ?? parts.find(part => !part.piped);
  let words = selected?.words ?? [];
  if (basename(words[0] ?? '') === 'env') words = words.slice(1);
  while (words[0] && /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0])) words = words.slice(1);
  if (words[0] === 'sudo') words = words.slice(1);
  if (basename(words[0] ?? '') === 'o8' && words[1] === 'run') {
    const delimiter = words.indexOf('--', 2);
    if (delimiter >= 0) words = words.slice(delimiter + 1);
  }
  if (/^(?:ba|z|da)?sh$/.test(basename(words[0] ?? ''))) {
    const commandFlag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c$/.test(word));
    if (commandFlag >= 0) return activityCommandWords(words.slice(commandFlag + 1).join(' '), depth + 1);
  }
  while (words[0] && /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0])) words = words.slice(1);
  if (basename(words[0] ?? '') === 'npx') {
    words = words.slice(1);
    while (words[0]?.startsWith('-')) words = words.slice(1);
  }
  if (basename(words[0] ?? '') === 'git') {
    let index = 1;
    while (words[index]?.startsWith('-')) {
      index += /^(?:-C|-c|--git-dir|--work-tree)$/.test(words[index]) ? 2 : 1;
    }
    words = [words[0], ...words.slice(index)];
  }
  return words;
}
