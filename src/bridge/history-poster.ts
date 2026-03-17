// src/bridge/history-poster.ts
export interface Turn {
  userText: string;
  assistantText: string;
}

const MAX_TURNS = 15;

export function parseTurnsFromJsonl(content: string): Turn[] {
  const lines = content.split('\n').filter(Boolean);
  const turns: Turn[] = [];
  let currentUser: string | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user') {
        currentUser = extractText(entry.message?.content);
      } else if (entry.type === 'assistant' && currentUser !== null) {
        const assistantText = extractAssistantText(entry.message?.content);
        turns.push({ userText: currentUser, assistantText });
        currentUser = null;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns.slice(-MAX_TURNS);
}

function extractText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
}

function extractAssistantText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'text') {
      parts.push(c.text);
    } else if (c.type === 'tool_use') {
      const input = c.input || {};
      const summary = Object.values(input)[0] || '';
      parts.push(`🔧 ${c.name}: ${String(summary).slice(0, 80)}`);
    }
  }
  return parts.join('\n');
}

export function formatTurnForSlack(params: {
  userText: string;
  assistantText: string;
  turnIndex: number;
}): string {
  return `*User:*\n${params.userText}\n\n*Assistant:*\n${params.assistantText}`;
}
