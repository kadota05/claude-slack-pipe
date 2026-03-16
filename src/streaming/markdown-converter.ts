// src/streaming/markdown-converter.ts

interface Segment {
  type: 'text' | 'codeblock';
  content: string;
  lang?: string;
}

/**
 * Convert GitHub Flavored Markdown to Slack mrkdwn format.
 * Strategy: Protect code → Convert text segments → Restore.
 * Performance: <1ms for 3000 chars.
 */
export function convertMarkdownToMrkdwn(markdown: string): string {
  const segments = splitCodeBlocks(markdown);
  const converted = segments.map(seg => {
    if (seg.type === 'codeblock') {
      return '```\n' + seg.content + '\n```';
    }
    return convertTextSegment(seg.content);
  });
  return converted.join('');
}

function splitCodeBlocks(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /^```(\w*)\s*\n([\s\S]*?)^```\s*$/gm;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: markdown.slice(lastIndex, match.index) });
    }
    // Remove trailing newline from content (it's added back during output)
    const content = match[2].endsWith('\n') ? match[2].slice(0, -1) : match[2];
    segments.push({ type: 'codeblock', content, lang: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ type: 'text', content: markdown.slice(lastIndex) });
  }

  return segments;
}

function convertTextSegment(text: string): string {
  // 1. Protect inline code
  const inlineCodes: string[] = [];
  let result = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push('`' + code + '`');
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 2. Protect links (before any other processing)
  const links: string[] = [];
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const link = `<${url}|${alt}>`;
    links.push(link);
    return `\x00LK${links.length - 1}\x00`;
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const link = `<${url}|${linkText}>`;
    links.push(link);
    return `\x00LK${links.length - 1}\x00`;
  });

  // 3. Escape chars (must be before inline formatting to protect escaped chars)
  // Replace escaped chars with placeholders so they aren't treated as formatting
  const escapedChars: string[] = [];
  result = result.replace(/\\([*_~`\[\]])/g, (_, char) => {
    escapedChars.push(char);
    return `\x00EC${escapedChars.length - 1}\x00`;
  });

  // 4. Tables (must be before other line-level transforms)
  result = convertTables(result);

  // 5. Headers: # text → *text* (protect result with placeholder to avoid italic conversion)
  const headers: string[] = [];
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_, content) => {
    headers.push(`*${content}*`);
    return `\x00HD${headers.length - 1}\x00`;
  });

  // 6. Task lists (before unordered list conversion)
  result = result.replace(/^(\s*)- \[ \] (.+)$/gm, '$1☐ $2');
  result = result.replace(/^(\s*)- \[x\] (.+)$/gm, '$1☑ $2');

  // 7. Unordered lists: - item or * item → • item
  result = result.replace(/^(\s*)[-*] (.+)$/gm, '$1• $2');

  // 8. Bold+Italic: ***text*** → *_text_*
  const boldItalics: string[] = [];
  result = result.replace(/\*{3}([^*\n]+?)\*{3}/g, (_, content) => {
    boldItalics.push(`*_${content}_*`);
    return `\x00BI${boldItalics.length - 1}\x00`;
  });

  // 9. Bold: **text** → *text*
  const bolds: string[] = [];
  result = result.replace(/\*{2}([^*\n]+?)\*{2}/g, (_, content) => {
    bolds.push(`*${content}*`);
    return `\x00BD${bolds.length - 1}\x00`;
  });

  // 10. Italic: *text* → _text_ (remaining single *)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '_$1_');

  // 11. Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~([^~\n]+?)~~/g, '~$1~');

  // 12. Horizontal rule
  result = result.replace(/^[-*_]{3,}\s*$/gm, '───────────────');

  // 13. HTML tags
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<[^>]+>/g, '');

  // 14. Restore placeholders
  result = result.replace(/\x00BI(\d+)\x00/g, (_, idx) => boldItalics[Number(idx)]);
  result = result.replace(/\x00BD(\d+)\x00/g, (_, idx) => bolds[Number(idx)]);
  result = result.replace(/\x00HD(\d+)\x00/g, (_, idx) => headers[Number(idx)]);
  result = result.replace(/\x00LK(\d+)\x00/g, (_, idx) => links[Number(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[Number(idx)]);
  result = result.replace(/\x00EC(\d+)\x00/g, (_, idx) => escapedChars[Number(idx)]);

  return result;
}

function convertTables(text: string): string {
  const tableRegex = /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm;

  return text.replace(tableRegex, (match) => {
    const rows = match.trim().split('\n');
    if (rows.length < 3) return match;

    const parsedRows: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === 1) continue;
      const cells = rows[i]
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(c => c.trim());
      parsedRows.push(cells);
    }

    if (parsedRows.length === 0) return match;

    const colCount = parsedRows[0].length;
    const widths: number[] = new Array(colCount).fill(0);
    for (const row of parsedRows) {
      for (let i = 0; i < colCount; i++) {
        widths[i] = Math.max(widths[i], getDisplayWidth(row[i] || ''));
      }
    }

    const border = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const lines = [border];

    for (let r = 0; r < parsedRows.length; r++) {
      const row = parsedRows[r];
      const cells = row.map((cell, i) => {
        const pad = widths[i] - getDisplayWidth(cell);
        return ' ' + cell + ' '.repeat(pad + 1);
      });
      lines.push('|' + cells.join('|') + '|');
      if (r === 0) lines.push(border);
    }
    lines.push(border);

    return '```\n' + lines.join('\n') + '\n```';
  });
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    width += isCJK(code) ? 2 : 1;
  }
  return width;
}

function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}
