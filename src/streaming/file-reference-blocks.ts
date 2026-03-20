import type { Block } from './types.js';

export function buildFileReferenceBlocks(filePaths: string[], maxBlocks?: number): Block[] {
  if (filePaths.length === 0) return [];

  const blocks: Block[] = [];
  blocks.push({ type: 'divider' });

  const limit = maxBlocks ? maxBlocks - 1 : filePaths.length;
  for (const filePath of filePaths.slice(0, limit)) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:page_facing_up: \`${filePath}\``,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '表示' },
        action_id: 'view_file_content',
        value: filePath,
      },
    } as any);
  }

  return blocks;
}
