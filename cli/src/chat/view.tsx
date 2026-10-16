import React from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { graphemes, type InputValue } from './input.js';
import { safeText, type ChatMessage } from './state.js';

const colors = { accent: '#8ab4ff', soft: '#b9cdf2', muted: '#a3aab6', dim: '#7c8494', error: '#f09797' };
export const palette = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name,
  process.env.NO_COLOR !== undefined ? undefined : color,
])) as Record<keyof typeof colors, string | undefined>;
export interface ViewLine { text: string; tone?: keyof typeof palette; bold?: boolean }

export function transcriptLines(messages: ChatMessage[], width: number, expanded: boolean): ViewLine[] {
  const lines: ViewLine[] = [];
  const append = (text: string, tone?: ViewLine['tone'], bold = false) => {
    for (const line of wrapAnsi(safeText(text), Math.max(8, width), { hard: true, trim: false }).split('\n')) {
      lines.push({ text: line, tone, bold });
    }
  };
  for (const message of messages) {
    append(message.role === 'user' ? '›  You' : message.role === 'notice' ? '·  Session' : '◉  o8', message.role === 'user' ? 'soft' : 'accent', true);
    let code = false;
    for (const line of message.text.split('\n')) {
      if (line.startsWith('```')) { code = !code; append(code ? `┌ ${line.slice(3) || 'code'}` : '└', 'dim'); continue; }
      append(code ? `│ ${line}` : line.replace(/^#{1,6}\s+/, ''), code ? 'soft' : undefined, /^#{1,6}\s/.test(line));
    }
    for (const tool of message.tools) {
      const symbol = tool.status === 'done' ? '✓' : tool.status === 'error' ? '!' : '·';
      append(`  ${symbol} ${tool.name}${expanded ? '' : '  ·  Ctrl+O for details'}`, tool.status === 'error' ? 'error' : 'muted');
      if (expanded) {
        append(tool.input, 'dim');
        if (tool.output) append(tool.output, tool.status === 'error' ? 'error' : 'muted');
      }
    }
    append('');
  }
  return lines;
}

/** Wrap before rendering, preserving a grapheme cursor even with wide glyphs. */
export function composerLines(value: InputValue, width: number) {
  const lines: string[][] = [[]];
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = 0;
  const chars = [...graphemes(value.text), ' '];
  chars.forEach((char, index) => {
    if (column + stringWidth(char) > width) { lines.push([]); column = 0; }
    if (index === value.cursor) { cursorRow = lines.length - 1; cursorColumn = lines[cursorRow]!.length; }
    if (char === '\n') { lines.push([]); column = 0; }
    else { lines[lines.length - 1]!.push(char); column += stringWidth(char); }
  });
  return { lines, cursorRow, cursorColumn };
}

export function Composer({ value, width, connected }: { value: InputValue; width: number; connected: boolean }) {
  const { lines, cursorRow, cursorColumn } = composerLines(value, Math.max(8, width - 6));
  const firstRow = Math.max(0, cursorRow - 3);
  return <Box borderStyle="round" borderColor={connected ? palette.accent : palette.dim} paddingLeft={1} paddingRight={1} flexDirection="column" width={width}>
    {lines.slice(firstRow, firstRow + 4).map((chars, index) => {
      const focused = firstRow + index === cursorRow;
      return <Text key={firstRow + index}>
        <Text color={palette.accent}>{index === 0 ? '› ' : '  '}</Text>
        {!value.text && index === 0
          ? <><Text inverse> </Text><Text color={palette.muted}>What would you like to work on?</Text></>
          : focused
            ? <>{chars.slice(0, cursorColumn).join('')}<Text inverse>{chars[cursorColumn] || ' '}</Text>{chars.slice(cursorColumn + 1).join('')}</>
            : chars.join('')}
      </Text>;
    })}
  </Box>;
}

export function Transcript({ lines, height, offset }: { lines: ViewLine[]; height: number; offset: number }) {
  const end = Math.max(height, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - height), end);
  return <Box height={height} flexDirection="column" overflow="hidden">
    {visible.map((line, index) => <Text key={index} color={line.tone ? palette[line.tone] : undefined} bold={line.bold}>{line.text || ' '}</Text>)}
  </Box>;
}

export function Welcome({ repo, width }: { repo: string; width: number }) {
  return <Box flexDirection="column" marginTop={1} marginBottom={1}>
    <Text color={palette.accent}>   ╭──╮ ╭──╮</Text>
    <Text color={palette.accent}>   │  │ ├──┤    <Text bold>o8</Text><Text color={palette.muted}> / terminal</Text></Text>
    <Text color={palette.accent}>   ╰──╯ ╰──╯</Text>
    <Box marginTop={1} flexDirection="column">
      <Text bold>A little room to do good work.</Text>
      <Text color={palette.muted}>Ask, build, and follow the work as it happens.</Text>
      <Text color={palette.dim}>{safeText(repo).slice(-Math.max(20, width - 2))}</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text color={palette.soft}>Start with a task or a question.</Text>
      <Text color={palette.muted}>Type <Text color={palette.accent}>/help</Text> for the short guide.</Text>
    </Box>
  </Box>;
}
