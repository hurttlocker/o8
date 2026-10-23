/** Extract search terms for display only; shell input is never evaluated. */
export function activitySearchTerms(executable: string, tokens: string[], args: Record<string, unknown>): string[] {
  const terms = ['pattern', 'query', 'search_term', 'searchTerm', 'regex']
    .flatMap(key => typeof args[key] === 'string' && args[key] ? [args[key] as string] : []);
  const words = tokens.slice(executable === 'git' ? 2 : 1);
  if (executable === 'find') {
    for (let index = 0; index < words.length; index += 1) {
      if (/^-(?:i?(?:name|path|regex))$/.test(words[index]) && words[index + 1]) terms.push(words[++index]);
    }
  } else if (/^(rg|grep)$/.test(executable) || executable === 'git' && tokens[1] === 'grep') {
    const explicit = words.some(word => /^-(?:e|f)|^--(?:regexp|file)(?:=|$)/.test(word));
    const fileListing = words.includes('--files');
    const takesValue = /^(?:-g|--glob|--iglob|-t|--type|-T|--type-not|-A|-B|-C|--after-context|--before-context|--context|-m|--max-count|--max-depth|--maxdepth|--encoding|--sort|--sortr|--include|--exclude|--exclude-dir|-f|--file)$/;
    let positional = false;
    let options = true;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (fileListing && /^\d*[<>]/.test(word)) {
        if (/^\d*(?:>>?|<<?)$/.test(word)) index += 1;
        continue;
      }
      if (options && word === '--') { options = false; continue; }
      if (options && /^(?:-e|--regexp)$/.test(word)) {
        if (words[index + 1]) terms.push(words[++index]);
      } else if (options && word.startsWith('--regexp=')) {
        terms.push(word.slice('--regexp='.length));
      } else if (options && /^-e.+/.test(word)) {
        terms.push(word.slice(2));
      } else if (options && takesValue.test(word)) {
        index += 1;
      } else if (options && word.startsWith('-')) {
        continue;
      } else if (fileListing) {
        // Filename discovery searches these scopes; they are not read files.
        terms.push(word);
      } else if (!explicit && !positional) {
        terms.push(word);
        positional = true;
      }
    }
  }
  return [...new Set(terms)];
}
