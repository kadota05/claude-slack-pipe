import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile } from '../slack/file-processor.js';
import { logger } from '../utils/logger.js';

interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

export async function downloadFilesToTemp(
  files: SlackFileRef[],
  botToken: string,
  tempDir: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    if (!file.url_private_download) {
      logger.warn(`Skipping file ${file.name}: no download URL`);
      continue;
    }
    try {
      const buffer = await downloadFile(file.url_private_download, botToken);
      const filePath = path.join(tempDir, `${file.id}-${file.name}`);
      await fs.writeFile(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      logger.warn(`Failed to download file ${file.name}:`, err);
    }
  }
  return paths;
}
