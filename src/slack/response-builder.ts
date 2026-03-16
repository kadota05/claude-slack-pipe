const MAX_MESSAGE_TEXT = 3_900;
const FILE_UPLOAD_THRESHOLD = 39_000;

export interface SplitResult {
  type: 'single' | 'multi' | 'file_upload';
  chunks: string[];
}

export function splitMessage(text: string): SplitResult {
  if (text.length <= MAX_MESSAGE_TEXT) {
    return { type: 'single', chunks: [text] };
  }

  if (text.length > FILE_UPLOAD_THRESHOLD) {
    return { type: 'file_upload', chunks: [text] };
  }

  const chunks = splitAtBoundaries(text, MAX_MESSAGE_TEXT);
  return { type: 'multi', chunks };
}

export function splitAtBoundaries(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findBestCutPoint(remaining, maxLength);
    chunks.push(remaining.substring(0, cutPoint).trimEnd());
    remaining = remaining.substring(cutPoint).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

function findBestCutPoint(text: string, maxLength: number): number {
  const searchRegion = text.substring(0, maxLength);

  // Priority 1: Markdown heading
  const headingMatch = findLastMatch(searchRegion, /\n#{1,3}\s/g);
  if (headingMatch !== -1 && headingMatch > maxLength * 0.3) {
    return headingMatch + 1; // Include the newline
  }

  // Priority 2: Code block end
  const codeBlockEnd = findLastMatch(searchRegion, /\n```\n/g);
  if (codeBlockEnd !== -1 && codeBlockEnd > maxLength * 0.3) {
    // Check we're not splitting inside a code block
    if (!isInsideCodeBlock(searchRegion, codeBlockEnd + 4)) {
      return codeBlockEnd + 4;
    }
  }

  // Priority 3: Empty line (paragraph boundary)
  const emptyLine = findLastMatch(searchRegion, /\n\n/g);
  if (emptyLine !== -1 && emptyLine > maxLength * 0.3) {
    if (!isInsideCodeBlock(searchRegion, emptyLine)) {
      return emptyLine + 2;
    }
  }

  // Priority 4: Sentence end
  const sentenceEnd = findLastMatch(searchRegion, /[.!?\u3002]\s/g);
  if (sentenceEnd !== -1 && sentenceEnd > maxLength * 0.3) {
    if (!isInsideCodeBlock(searchRegion, sentenceEnd)) {
      return sentenceEnd + 2;
    }
  }

  // Priority 5: Any line break
  const lineBreak = searchRegion.lastIndexOf('\n');
  if (lineBreak !== -1 && lineBreak > maxLength * 0.2) {
    return lineBreak + 1;
  }

  // Priority 6: Force split at maxLength
  return maxLength;
}

function findLastMatch(text: string, regex: RegExp): number {
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    lastIndex = match.index;
  }
  return lastIndex;
}

function isInsideCodeBlock(text: string, position: number): boolean {
  const beforePos = text.substring(0, position);
  const fenceCount = (beforePos.match(/```/g) || []).length;
  return fenceCount % 2 !== 0; // Odd count means we're inside a code block
}
