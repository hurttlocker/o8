export interface InlineMarkdownImage {
  altText: string;
  dataUri: string;
  mimeType: string;
  base64Data: string;
}

export type InlineMarkdownPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: InlineMarkdownImage };

export interface ParsedInlineMarkdownContent {
  hasImages: boolean;
  parts: InlineMarkdownPart[];
}

const INLINE_MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\((data:([^;]+);base64,([^)]+))\)/g;

export function parseInlineMarkdownDataImages(content: string): ParsedInlineMarkdownContent {
  const parts: InlineMarkdownPart[] = [];
  let hasImages = false;
  let lastIndex = 0;

  for (const match of content.matchAll(INLINE_MARKDOWN_IMAGE_REGEX)) {
    hasImages = true;

    const textBefore = content.slice(match.index === undefined ? 0 : lastIndex, match.index).trim();
    if (textBefore) {
      parts.push({ type: 'text', text: textBefore });
    }

    parts.push({
      type: 'image',
      image: {
        altText: match[1] ?? '',
        dataUri: match[2] ?? '',
        mimeType: match[3] ?? 'image/png',
        base64Data: match[4] ?? '',
      },
    });

    lastIndex = (match.index ?? 0) + match[0].length;
  }

  if (!hasImages) {
    return { hasImages: false, parts: [] };
  }

  const remaining = content.slice(lastIndex).trim();
  if (remaining) {
    parts.push({ type: 'text', text: remaining });
  }

  return {
    hasImages: true,
    parts,
  };
}
