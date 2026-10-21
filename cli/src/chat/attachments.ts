import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composerBackendSupportsImages, validateComposerImageAttachments, type ComposerImageAttachment } from '../../../src/lib/mobile/composer-image-validation.js';
import { safeText } from './state.js';

const MAX_IMAGE_BYTES = 3_700_000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export interface Attachment {
  path: string;
  name: string;
  bytes: number;
  image?: ComposerImageAttachment;
  text?: string;
}

/** Parse terminal-dropped paths without ever invoking a shell or expanding code. */
export function attachmentPaths(input: string): string[] {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error('Attach file paths on one line.');
  const paths: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) { word += char; escaped = false; }
    else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (word) paths.push(word); word = ''; }
    else word += char;
  }
  if (quote || escaped) throw new Error('Finish quoting the file path before attaching it.');
  if (word) paths.push(word);
  if (!paths.length) throw new Error('Use /attach <path>. Quote paths that contain spaces.');
  if (paths.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
  return paths;
}

export function pastedAttachmentPaths(text: string): string[] | null {
  try {
    const paths = attachmentPaths(text);
    return paths.every((path) => /^(?:\/|~\/|\.\.?\/|file:\/\/)/.test(path)) ? paths : null;
  } catch { return null; }
}

function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}

async function readAttachment(path: string, cwd: string): Promise<Attachment> {
  const expanded = path.startsWith('file://') ? fileURLToPath(path) : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  const canonical = await realpath(expanded);
  // Nonblocking open prevents named pipes/devices from hanging the terminal.
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Choose a regular file, not a directory or device.');
    if (info.size > MAX_IMAGE_BYTES) throw new Error('File exceeds the 3.7 MB image limit (text limit: 256 KiB).');
    const buffer = Buffer.alloc(Math.min(MAX_IMAGE_BYTES + 1, info.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('File changed while attaching it. Try again.');
    const bytes = buffer.subarray(0, length);
    const attachment: Attachment = { path: canonical, name: safeText(basename(canonical)), bytes: length };
    const mime = imageType(bytes);
    if (mime) {
      attachment.image = validateComposerImageAttachments([{ name: attachment.name, dataUri: `data:${mime};base64,${bytes.toString('base64')}` }])[0];
    } else {
      if (length > MAX_TEXT_BYTES) throw new Error('Text files must be at most 256 KiB. Attach a smaller excerpt.');
      if (bytes.includes(0) || bytes.subarray(0, 5).toString() === '%PDF-') throw new Error('This file is binary. Attach an image or a UTF-8 text file.');
      try { attachment.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('This file is not UTF-8 text. Attach an image or a UTF-8 text file.'); }
    }
    return attachment;
  } finally { await file.close(); }
}

export async function stageAttachments(paths: string[], current: Attachment[], cwd: string, backend: string): Promise<Attachment[]> {
  const next = [...current];
  for (const path of paths) {
    const item = await readAttachment(path, cwd);
    if (next.some((old) => old.path === item.path)) continue;
    if (item.image && !composerBackendSupportsImages(backend)) throw new Error('This backend does not accept images. Your draft and existing attachments are preserved.');
    if (next.length >= MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
    next.push(item);
    if (next.reduce((sum, file) => sum + (file.text !== undefined ? file.bytes : 0), 0) > MAX_TOTAL_TEXT_BYTES) throw new Error('Text attachments exceed 1 MiB in total.');
  }
  return next;
}

export function attachmentTurn(text: string, attachments: Attachment[]) {
  const labels = attachments.map((file) => `[${file.image ? 'Image' : 'File'}: ${file.name}]`);
  const displayMessage = [text, ...labels].filter(Boolean).join('\n');
  const files = attachments.filter((file) => file.text !== undefined).map((file) => ({ name: file.name, content: file.text }));
  return {
    displayMessage,
    message: files.length ? `${displayMessage}\n\nAttached files (JSON data):\n${JSON.stringify(files)}` : displayMessage,
    attachments: attachments.flatMap((file) => file.image ? [file.image] : []),
  };
}
