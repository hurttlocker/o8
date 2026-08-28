export function getMonacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name.startsWith('.env')) return 'ini';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === '.gitignore' || name === '.dockerignore') return 'plaintext';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown', html: 'html', xml: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    swift: 'swift', kt: 'kotlin',
    r: 'r', lua: 'lua', php: 'php', perl: 'perl',
    ini: 'ini', conf: 'ini', cfg: 'ini',
  };
  return map[ext] || 'plaintext';
}

export function defineCortexMonacoThemes(monaco: typeof import('monaco-editor')) {
  monaco.editor.defineTheme('cortex-graphite', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8f99a6', fontStyle: 'italic' },
      { token: 'keyword', foreground: '9db5ff' },
      { token: 'string', foreground: '7fd6b7' },
      { token: 'number', foreground: 'f1b57f' },
      { token: 'type', foreground: 'd6c48f' },
      { token: 'variable', foreground: 'f2a8b8' },
      { token: 'function', foreground: '8fc0ff' },
    ],
    colors: {
      'editor.background': '#3d434b',
      'editor.foreground': '#eef3f8',
      'editor.lineHighlightBackground': '#49515b',
      'editor.selectionBackground': '#7aa2ff33',
      'editorLineNumber.foreground': '#8893a0',
      'editorLineNumber.activeForeground': '#dbe4ee',
      'editor.inactiveSelectionBackground': '#7aa2ff1f',
      'editorCursor.foreground': '#7aa2ff',
      'editorGutter.background': '#3d434b',
      'editorWidget.background': '#444b55',
      'editorWidget.border': '#65707d',
      'input.background': '#343a42',
      'input.border': '#65707d',
      'focusBorder': '#7aa2ff',
      'minimap.background': '#3d434b',
      'scrollbarSlider.background': '#65707d88',
      'scrollbarSlider.hoverBackground': '#7b879488',
      'diffEditor.insertedTextBackground': '#16653433',
      'diffEditor.insertedLineBackground': '#1665341f',
      'diffEditor.removedTextBackground': '#1d4ed833',
      'diffEditor.removedLineBackground': '#1d4ed81f',
      'diffEditor.diagonalFill': '#3d434b',
    },
  });

  monaco.editor.defineTheme('cortex-frost', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6366f1' },
      { token: 'string', foreground: '0d9488' },
      { token: 'number', foreground: 'e879a0' },
      { token: 'type', foreground: '8b5cf6' },
      { token: 'variable', foreground: '0284c7' },
      { token: 'function', foreground: '4f46e5' },
      { token: 'delimiter', foreground: '94a3b8' },
      { token: 'tag', foreground: 'e879a0' },
      { token: 'attribute.name', foreground: '8b5cf6' },
      { token: 'attribute.value', foreground: '0d9488' },
      { token: 'operator', foreground: '64748b' },
      { token: 'regexp', foreground: 'e879a0' },
    ],
    colors: {
      'editor.background': '#f0f7ff',
      'editor.foreground': '#1e293b',
      'editor.lineHighlightBackground': '#e8f1fc',
      'editor.selectionBackground': '#c7d2fe',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#475569',
      'editor.inactiveSelectionBackground': '#c7d2fe60',
      'editorCursor.foreground': '#4f46e5',
      'editorGutter.background': '#f0f7ff',
      'editorWidget.background': '#f8fafc',
      'editorWidget.border': '#cbd5e1',
      'input.background': '#ffffff',
      'input.border': '#cbd5e1',
      'focusBorder': '#6366f1',
      'minimap.background': '#f0f7ff',
      'scrollbarSlider.background': '#94a3b840',
      'scrollbarSlider.hoverBackground': '#64748b40',
      'editorBracketMatch.background': '#e0e7ff',
      'editorBracketMatch.border': '#a5b4fc',
      'diffEditor.insertedTextBackground': '#dcfce766',
      'diffEditor.insertedLineBackground': '#dcfce740',
      'diffEditor.removedTextBackground': '#dbeafe88',
      'diffEditor.removedLineBackground': '#dbeafe55',
      'diffEditor.diagonalFill': '#f0f7ff',
    },
  });
}
