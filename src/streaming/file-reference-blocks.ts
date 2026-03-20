import type { Block } from './types.js';

export function buildFileReferenceBlocks(filePaths: string[], maxBlocks?: number): Block[] {
  if (filePaths.length === 0) return [];

  const blocks: Block[] = [];
  blocks.push({ type: 'divider' });

  const limit = maxBlocks ? maxBlocks - 1 : filePaths.length;
  const buttons: any[] = [];
  for (const filePath of filePaths.slice(0, limit)) {
    const fileName = filePath.split('/').pop() || filePath;
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: `📄 ${fileName}` },
      action_id: `view_file_content:${buttons.length}`,
      value: filePath,
    });
  }

  // Max 25 buttons per actions block
  for (let i = 0; i < buttons.length; i += 25) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(i, i + 25),
    } as any);
  }

  return blocks;
}
